const API_BASE = (import.meta.env.VITE_SIDEAI_API_BASE as string | undefined)?.replace(/\/$/, "").trim() || "http://127.0.0.1:8000";

/**
 * Retrieve the current Clerk session token (if signed in) for backend auth.
 * We read it from Clerk's window object to avoid importing Clerk hooks inside
 * a non-React context. Returns empty string when not signed in.
 */
async function getClerkToken(): Promise<string> {
  try {
    // __clerk_db_jwt is the raw session token Clerk stores in window — works in Electron/Chromium
    const session = (window as any).__clerk?.session;
    if (session) {
      const token = await session.getToken();
      return token ?? "";
    }
  } catch (_) {}
  return "";
}

/** Attaches X-DuckAI-Key (optional API lock) and Authorization (Clerk JWT) headers. */
async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  const key = import.meta.env.VITE_SIDEAI_API_KEY as string | undefined;
  if (key) headers.set("X-DuckAI-Key", key);
  const clerkToken = await getClerkToken();
  if (clerkToken) headers.set("Authorization", `Bearer ${clerkToken}`);
  const p = path.startsWith("/") ? path : `/${path}`;
  return fetch(`${API_BASE}${p}`, { ...init, headers });
}

export async function healthCheck(): Promise<boolean> {
  try {
    const r = await backendFetch("/health", { method: "GET" });
    return r.ok;
  } catch {
    return false;
  }
}

export interface BackendMeta {
  app: string;
  uptime_seconds: number;
  capture_paused: boolean;
  context_stale_seconds: number | null;
  features: string[];
}

export async function fetchBackendMeta(): Promise<BackendMeta> {
  const r = await backendFetch(`/api/meta`);
  if (!r.ok) throw new Error("Failed to fetch meta");
  return r.json() as Promise<BackendMeta>;
}

export async function fetchContext(): Promise<{
  active_app: string;
  window_title: string;
  visible_text: string;
  task: string;
  ocr_confidence?: number;
  privacy_blocked?: boolean;
  captured_at?: number;
}> {
  const r = await backendFetch(`/api/context`);
  if (!r.ok) throw new Error("Failed to fetch context");
  return r.json();
}

export async function fetchSuggestions(): Promise<{ suggestions: string[] }> {
  const r = await backendFetch(`/api/suggestions`);
  if (!r.ok) throw new Error("Failed to fetch suggestions");
  return r.json();
}

export interface TimelineContext {
  id: string;
  active_app: string;
  window_title: string;
  visible_text: string;
  task: string;
  ocr_confidence?: number;
  privacy_blocked?: boolean;
  captured_at?: number;
}

export async function fetchContextTimeline(): Promise<{ timeline: TimelineContext[] }> {
  const r = await backendFetch(`/api/context_timeline`);
  if (!r.ok) throw new Error("Failed to fetch context timeline");
  return r.json();
}

export async function captureNow(): Promise<void> {
  const r = await backendFetch(`/api/capture_now`, { method: "POST" });
  if (!r.ok) throw new Error("Failed to capture");
}

export async function getCapturePaused(): Promise<boolean> {
  const r = await backendFetch(`/api/capture_paused`);
  if (!r.ok) return false;
  const data = await r.json();
  return (data as { paused: boolean }).paused;
}

export async function setCapturePaused(paused: boolean): Promise<void> {
  const r = await backendFetch(`/api/capture_paused`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused }),
  });
  if (!r.ok) throw new Error("Failed to set pause");
}

export async function typeText(
  text: string,
  options?: {
    method?: "auto" | "type" | "paste";
    delaySeconds?: number;
    /** When true (default), prior plain-text clipboard is restored after paste completes. */
    restoreClipboard?: boolean;
    pasteRetries?: number;
    clipboardSettleMs?: number;
    interPasteMs?: number;
  }
): Promise<void> {
  const r = await backendFetch(`/api/type_text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      method: options?.method ?? "auto",
      delay_seconds: options?.delaySeconds ?? 2,
      restore_clipboard: options?.restoreClipboard !== false,
      paste_retries: options?.pasteRetries ?? 2,
      clipboard_settle_ms: options?.clipboardSettleMs ?? 95,
      inter_paste_ms: options?.interPasteMs ?? 85,
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Type failed");
  }
}

export interface ContextReceiptV2 {
  schema_version: string;
  active_app: string;
  window_title: string;
  captured_at?: number;
  capture_size_chars: number;
  ocr_confidence: number;
  privacy_blocked: boolean;
  blocked_fields: string[];
  redacted_fields: string[];
}

export interface ResponseConfidence {
  score: number;
  band: "low" | "medium" | "high";
  factors: {
    ocr_confidence: number;
    context_freshness: number;
    sources_count: number;
    verification_confidence: number;
  };
}

export interface ResponseVerification {
  verified: boolean;
  confidence: number;
  sources_used: Array<{ title: string; url: string; supports: boolean }>;
  contradictions: string[];
  notes: string;
}

export interface ChatResponseMetadata {
  memory_mode?: "this_chat_only" | "remember_24h" | "never_remember";
  context_receipt_v2?: ContextReceiptV2 | null;
  confidence?: ResponseConfidence | null;
  verification?: ResponseVerification | null;
  smart_followups?: string[];
}

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  id?: string;
  meta?: ChatResponseMetadata;
};

/** Optional flags for /api/chat and /api/chat/stream */
export type ChatRequestOptions = {
  /** When false, backend does not inject live screen capture (web-only answers). Default true. */
  useScreenContext?: boolean;
  memoryMode?: "this_chat_only" | "remember_24h" | "never_remember";
};

export async function sendChat(
  messages: ChatMessage[],
  context: Record<string, unknown> | null,
  conversationId?: string | null,
  options?: ChatRequestOptions
): Promise<{
  content: string;
  conversation_id?: string | null;
  context_receipt_v2?: ContextReceiptV2 | null;
  confidence?: ResponseConfidence | null;
  verification?: ResponseVerification | null;
  smart_followups?: string[];
}> {
  const r = await backendFetch(`/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      context,
      conversation_id: conversationId ?? null,
      use_screen_context: options?.useScreenContext !== false,
      memory_mode: options?.memoryMode ?? "this_chat_only",
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Chat request failed");
  }
  return r.json();
}

export async function sendChatStream(
  messages: ChatMessage[],
  context: Record<string, unknown> | null,
  onChunk: (chunk: string) => void,
  conversationId?: string | null,
  signal?: AbortSignal,
  options?: ChatRequestOptions,
  onEvent?: (event: ChatResponseMetadata) => void
): Promise<void> {
  const r = await backendFetch(`/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      context,
      conversation_id: conversationId ?? null,
      use_screen_context: options?.useScreenContext !== false,
      memory_mode: options?.memoryMode ?? "this_chat_only",
    }),
    signal,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Stream failed");
  }
  const reader = r.body?.getReader();
  if (!reader) throw new Error("No body");
  const dec = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        let data: { content?: string; error?: string; event?: string; metadata?: ChatResponseMetadata } | null = null;
        try {
          data = JSON.parse(line.slice(6)) as { content?: string; error?: string };
        } catch {
          data = null;
        }
        if (!data) continue;
        if (data.error) throw new Error(data.error);
        if (data.content) onChunk(data.content);
        if (data.event === "final" && data.metadata) onEvent?.(data.metadata);
      }
    }
  }
}

export type ContextSnapshotSlot = "a" | "b";

export async function saveContextSnapshot(
  slot: ContextSnapshotSlot
): Promise<{ ok: boolean; slot: string; chars: number }> {
  const r = await backendFetch(`/api/context/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slot }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Snapshot failed");
  }
  return r.json() as Promise<{ ok: boolean; slot: string; chars: number }>;
}

export type ContextSnapshotMeta = {
  chars: number;
  captured_at?: number;
  active_app?: string;
  window_title?: string;
};

export async function fetchContextSnapshotsStatus(): Promise<{ a: ContextSnapshotMeta | null; b: ContextSnapshotMeta | null }> {
  const r = await backendFetch(`/api/context/snapshots/status`);
  if (!r.ok) throw new Error("Snapshot status failed");
  return r.json() as Promise<{ a: ContextSnapshotMeta | null; b: ContextSnapshotMeta | null }>;
}

export async function diffContextSnapshots(summarize: boolean): Promise<{
  unified_diff: string;
  a_chars: number;
  b_chars: number;
  a_meta?: Record<string, unknown>;
  b_meta?: Record<string, unknown>;
  summary?: string;
  summary_error?: string;
}> {
  const r = await backendFetch(`/api/context/diff?summarize=${summarize ? "true" : "false"}`, {
    method: "POST",
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Diff failed");
  }
  return r.json() as Promise<{
    unified_diff: string;
    a_chars: number;
    b_chars: number;
    summary?: string;
    summary_error?: string;
  }>;
}

export async function integrationNotionAppend(pageId: string, text: string): Promise<Record<string, unknown>> {
  const r = await backendFetch(`/api/integrations/notion/append`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page_id: pageId.trim(), text }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Notion append failed");
  }
  return r.json() as Promise<Record<string, unknown>>;
}

export async function integrationObsidianAppend(relativePath: string, text: string): Promise<Record<string, unknown>> {
  const r = await backendFetch(`/api/integrations/obsidian/append`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relative_path: relativePath.trim() || "DuckAI-inbox.md", text }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Obsidian append failed");
  }
  return r.json() as Promise<Record<string, unknown>>;
}

export async function integrationLinearIssue(title: string, description?: string): Promise<Record<string, unknown>> {
  const r = await backendFetch(`/api/integrations/linear/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title.trim(), description: description ?? "" }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Linear issue failed");
  }
  return r.json() as Promise<Record<string, unknown>>;
}

export async function integrationJiraIssue(summary: string, description?: string): Promise<Record<string, unknown>> {
  const r = await backendFetch(`/api/integrations/jira/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary: summary.trim(), description: description ?? "" }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Jira issue failed");
  }
  return r.json() as Promise<Record<string, unknown>>;
}

export interface PrivacySettings {
  blocked_apps: string[];
  redact_sensitive: boolean;
  meeting_focus?: boolean;
  context_allowlist_only?: boolean;
  allowed_apps?: string[];
}

export async function getPrivacySettings(): Promise<PrivacySettings> {
  const r = await backendFetch(`/api/privacy_settings`);
  if (!r.ok) throw new Error("Failed to load privacy settings");
  return r.json();
}

export async function savePrivacySettings(settings: PrivacySettings): Promise<PrivacySettings> {
  const r = await backendFetch(`/api/privacy_settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!r.ok) throw new Error("Failed to save privacy settings");
  return r.json();
}

export interface ScreenRecordingHealth {
  ok: boolean;
  hint: string;
  error?: string | null;
  blocked_reason?: string | null;
  visible_text_len?: number;
  python_capture_ok?: boolean;
  python_visible_text_len?: number;
  electron_ingest_recent?: boolean;
  context_source?: string | null;
  context_limited_reason?: string | null;
}

export interface PermissionHealth {
  platform: string;
  screen_recording: ScreenRecordingHealth;
  accessibility: { ok: boolean; hint: string; error?: string | null };
}

export async function fetchPermissionHealth(): Promise<PermissionHealth> {
  const r = await backendFetch(`/api/permissions/health`);
  if (!r.ok) throw new Error("Failed to load permission health");
  return r.json();
}

export interface ReminderItem {
  id: string;
  title: string;
  due: string | null;
  due_at?: number | null;
  done: boolean;
  created_at: number;
  notified?: boolean;
  snooze_until?: number;
}

export interface LastChatTransparency {
  updated_at?: number;
  use_screen_context?: boolean;
  active_app?: string;
  window_title?: string;
  visible_text_chars?: number;
  privacy_blocked?: boolean;
  meeting_focus_active?: boolean;
  context_limited_reason?: string | null;
  last_user_message_chars?: number;
}

export async function fetchReminders(): Promise<{ items: ReminderItem[] }> {
  const r = await backendFetch(`/api/reminders`);
  if (!r.ok) throw new Error("Failed to load reminders");
  return r.json();
}

export async function extractReminders(): Promise<{ items: ReminderItem[] }> {
  const r = await backendFetch(`/api/reminders/extract`, { method: "POST" });
  if (!r.ok) throw new Error("Failed to extract reminders");
  return r.json();
}

export async function setReminderDone(reminderId: string, done: boolean): Promise<ReminderItem> {
  const r = await backendFetch(`/api/reminders/${encodeURIComponent(reminderId)}/done`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done }),
  });
  if (!r.ok) throw new Error("Failed to update reminder");
  return r.json();
}

export async function createReminder(title: string, due?: string): Promise<ReminderItem> {
  const r = await backendFetch(`/api/reminders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, due: due ?? null }),
  });
  if (!r.ok) throw new Error("Failed to create reminder");
  return r.json();
}

export async function snoozeReminder(reminderId: string, minutes = 10): Promise<ReminderItem> {
  const r = await backendFetch(`/api/reminders/${encodeURIComponent(reminderId)}/snooze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minutes }),
  });
  if (!r.ok) throw new Error("Failed to snooze reminder");
  return r.json();
}

export async function fetchLastChatTransparency(): Promise<LastChatTransparency> {
  const r = await backendFetch(`/api/transparency/last_chat`);
  if (!r.ok) throw new Error("Failed to load transparency");
  return r.json();
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface ConversationItem {
  id: string;
  title: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  summary: string;
  app_context: string;
  starred: boolean;
  memory_mode?: "this_chat_only" | "remember_24h" | "never_remember";
  expires_at?: string | null;
}

export interface ConversationFull extends ConversationItem {
  messages: ConversationMessage[];
}

export async function createConversation(payload?: {
  title?: string;
  tags?: string[];
  app_context?: string;
  memory_mode?: "this_chat_only" | "remember_24h" | "never_remember";
}): Promise<ConversationItem> {
  const r = await backendFetch(`/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: payload?.title ?? "New conversation",
      tags: payload?.tags ?? [],
      app_context: payload?.app_context ?? "",
      memory_mode: payload?.memory_mode ?? "this_chat_only",
    }),
  });
  if (!r.ok) throw new Error("Failed to create conversation");
  return r.json();
}

export async function fetchConversations(params?: {
  query?: string;
  tag?: string;
  starred?: boolean;
}): Promise<{ items: ConversationItem[] }> {
  const q = new URLSearchParams();
  if (params?.query) q.set("query", params.query);
  if (params?.tag) q.set("tag", params.tag);
  if (typeof params?.starred === "boolean") q.set("starred", String(params.starred));
  const suffix = q.toString() ? `?${q.toString()}` : "";
  const r = await backendFetch(`/api/conversations${suffix}`);
  if (!r.ok) throw new Error("Failed to fetch conversations");
  return r.json();
}

export async function fetchConversation(conversationId: string): Promise<ConversationFull> {
  const r = await backendFetch(`/api/conversations/${encodeURIComponent(conversationId)}`);
  if (!r.ok) throw new Error("Failed to fetch conversation");
  return r.json();
}

export async function addConversationMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string
): Promise<ConversationMessage> {
  const r = await backendFetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, content }),
  });
  if (!r.ok) throw new Error("Failed to add conversation message");
  return r.json();
}

export async function setConversationMemoryMode(
  conversationId: string,
  memoryMode: "this_chat_only" | "remember_24h" | "never_remember"
): Promise<ConversationItem> {
  const r = await backendFetch(`/api/conversations/${encodeURIComponent(conversationId)}/memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memory_mode: memoryMode }),
  });
  if (!r.ok) throw new Error("Failed to set memory mode");
  return r.json();
}

export async function searchHistory(query: string, limit = 12): Promise<{ items: Array<Record<string, unknown>> }> {
  const r = await backendFetch(`/api/search-history`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
  if (!r.ok) throw new Error("Failed to search history");
  return r.json();
}

export async function exportConversation(
  conversationId: string,
  format: "markdown" | "json" | "pdf"
): Promise<{ format: string; filename: string; content?: string; content_base64?: string }> {
  const r = await backendFetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/export?format=${encodeURIComponent(format)}`,
    { method: "POST" }
  );
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Failed to export conversation");
  }
  return r.json();
}

export interface AppMode {
  mode: string;
  system_prompt: string;
  suggested_templates: string[];
}

export async function resolveAppMode(activeApp: string): Promise<{ active_app: string; mode: AppMode }> {
  const q = new URLSearchParams({ active_app: activeApp });
  const r = await backendFetch(`/api/app-modes/resolve?${q.toString()}`);
  if (!r.ok) throw new Error("Failed to resolve app mode");
  return r.json();
}

export async function searchWeb(query: string, limit = 3): Promise<{ items: Array<{ title: string; url: string; snippet: string }> }> {
  const r = await backendFetch(`/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
  if (!r.ok) throw new Error("Search failed");
  return r.json();
}

export type SynthesizeResult = {
  answer: string;
  hits: Array<{ title: string; url: string; snippet: string }>;
  synthesis_error?: string | null;
};

export async function synthesizeAnswer(
  query: string,
  context: Record<string, unknown> | null,
  opts?: { limit?: number }
): Promise<SynthesizeResult> {
  const r = await backendFetch(`/api/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      context: context ?? {},
      ...(opts?.limit != null ? { limit: opts.limit } : {}),
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Synthesis failed");
  }
  return r.json() as Promise<SynthesizeResult>;
}

export interface SavedResponse {
  id: string;
  content: string;
  context: string;
  app_context: string;
  tags: string[];
  saved_at: string;
}

export async function saveFavoriteResponse(payload: {
  content: string;
  app_context?: string;
  tags?: string[];
  context?: string;
}): Promise<SavedResponse> {
  const r = await backendFetch(`/api/responses/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: payload.content,
      app_context: payload.app_context ?? "",
      tags: payload.tags ?? [],
      context: payload.context ?? "",
    }),
  });
  if (!r.ok) throw new Error("Failed to save response");
  return r.json();
}

export async function fetchFavoriteResponses(): Promise<{ items: SavedResponse[] }> {
  const r = await backendFetch(`/api/responses/favorites`);
  if (!r.ok) throw new Error("Failed to load saved responses");
  return r.json();
}

export async function analyzeClipboard(content: string): Promise<{ type: string; suggestion: string; length?: number }> {
  const r = await backendFetch(`/api/clipboard/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw new Error("Failed to analyze clipboard");
  return r.json();
}

export interface TemplateItem {
  id: string;
  name: string;
  prompt: string;
  description: string;
  tags: string[];
  supported_apps: string[];
  category: string;
  is_built_in: boolean;
  input_schema?: Array<{ name: string; type: string; required: boolean; default?: string }>;
  source_message?: string;
}

export async function fetchTemplates(params?: { query?: string; tag?: string }): Promise<{ items: TemplateItem[] }> {
  const q = new URLSearchParams();
  if (params?.query) q.set("query", params.query);
  if (params?.tag) q.set("tag", params.tag);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  const r = await backendFetch(`/api/templates${suffix}`);
  if (!r.ok) throw new Error("Failed to fetch templates");
  return r.json();
}

export async function createTemplate(payload: {
  name: string;
  prompt: string;
  description?: string;
  tags?: string[];
  supported_apps?: string[];
  category?: string;
  input_schema?: Array<{ name: string; type: string; required: boolean; default?: string }>;
  source_message?: string;
}): Promise<TemplateItem> {
  const r = await backendFetch(`/api/templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      description: payload.description ?? "",
      tags: payload.tags ?? [],
      supported_apps: payload.supported_apps ?? [],
      category: payload.category ?? "general",
      input_schema: payload.input_schema ?? [],
      source_message: payload.source_message ?? "",
    }),
  });
  if (!r.ok) throw new Error("Failed to create template");
  return r.json();
}

export async function deleteTemplate(templateId: string): Promise<void> {
  const r = await backendFetch(`/api/templates/${encodeURIComponent(templateId)}`, { method: "DELETE" });
  if (!r.ok) throw new Error("Failed to delete template");
}

export async function importTemplates(
  items: Array<{
    name?: string;
    prompt?: string;
    description?: string;
    tags?: string[];
    supported_apps?: string[];
    category?: string;
    input_schema?: Array<{ name: string; type: string; required: boolean; default?: string }>;
    source_message?: string;
  }>
): Promise<{ items: TemplateItem[] }> {
  const r = await backendFetch(`/api/templates/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!r.ok) throw new Error("Failed to import templates");
  return r.json();
}

export async function saveWorkflowFromResponse(payload: {
  name: string;
  response_text: string;
  description?: string;
  tags?: string[];
}): Promise<TemplateItem> {
  const r = await backendFetch(`/api/workflows/from-response`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: payload.name,
      response_text: payload.response_text,
      description: payload.description ?? "",
      tags: payload.tags ?? [],
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Failed to save workflow");
  }
  return r.json();
}

export async function verifyChatAnswer(payload: {
  question: string;
  answer: string;
  hits?: Array<{ title: string; url: string; snippet: string }>;
  conversation_id?: string;
}): Promise<{ verification: ResponseVerification; hits: Array<{ title: string; url: string; snippet: string }> }> {
  const r = await backendFetch(`/api/chat/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: payload.question,
      answer: payload.answer,
      hits: payload.hits ?? [],
      conversation_id: payload.conversation_id ?? null,
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Verification failed");
  }
  return r.json();
}

export async function fetchSettings(): Promise<{ items: Record<string, { value: string; type: string }> }> {
  const r = await backendFetch(`/api/settings`);
  if (!r.ok) throw new Error("Failed to fetch settings");
  return r.json();
}

export async function patchSetting(
  key: string,
  value: string,
  type = "string"
): Promise<{ key: string; value: string; type: string }> {
  const r = await backendFetch(`/api/settings/${encodeURIComponent(key)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value, type }),
  });
  if (!r.ok) throw new Error("Failed to update setting");
  return r.json();
}

export interface HotkeyItem {
  id: string;
  key_combo: string;
  template_id: string;
  template_name?: string;
  enabled: boolean;
  created_at: string;
}

export async function fetchHotkeys(): Promise<{ items: HotkeyItem[] }> {
  const r = await backendFetch(`/api/hotkeys`);
  if (!r.ok) throw new Error("Failed to fetch hotkeys");
  return r.json();
}

export async function createHotkey(payload: {
  key_combo: string;
  template_id: string;
  enabled?: boolean;
}): Promise<HotkeyItem> {
  const r = await backendFetch(`/api/hotkeys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, enabled: payload.enabled ?? true }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Failed to create hotkey");
  }
  return r.json();
}

export async function deleteHotkey(hotkeyId: string): Promise<void> {
  const r = await backendFetch(`/api/hotkeys/${encodeURIComponent(hotkeyId)}`, { method: "DELETE" });
  if (!r.ok) throw new Error("Failed to delete hotkey");
}

export async function annotateImage(
  imageBase64: string,
  strokes: Array<{ points: Array<{ x: number; y: number }>; color?: string; width?: number }>
): Promise<{ image_base64: string }> {
  const r = await backendFetch(`/api/annotation/overlay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_base64: imageBase64, strokes }),
  });
  if (!r.ok) throw new Error("Failed to apply annotations");
  return r.json();
}

export interface KBDocument {
  id: string;
  title: string;
  content: string;
  source: string;
  tags: string[];
  created_at: string;
}

export async function ingestKBDocument(payload: {
  title: string;
  content: string;
  source?: string;
  tags?: string[];
}): Promise<KBDocument> {
  const r = await backendFetch(`/api/kb/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: payload.title,
      content: payload.content,
      source: payload.source ?? "",
      tags: payload.tags ?? [],
    }),
  });
  if (!r.ok) throw new Error("Failed to ingest document");
  return r.json();
}

export async function listKBDocuments(): Promise<{ items: KBDocument[] }> {
  const r = await backendFetch(`/api/kb/documents`);
  if (!r.ok) throw new Error("Failed to list documents");
  return r.json();
}

export async function queryKB(query: string, topK?: number): Promise<{
  answer: string;
  sources: Array<{ document_id: string; title: string; source: string; chunk_index: number; chunk: string; score: number }>;
}> {
  const r = await backendFetch(`/api/kb/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, top_k: topK }),
  });
  if (!r.ok) throw new Error("KB query failed");
  return r.json();
}

export async function visionAnalyze(imageBase64: string): Promise<{
  width: number;
  height: number;
  ocr_text: string;
  ocr_confidence: number;
}> {
  const r = await backendFetch(`/api/vision/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_base64: imageBase64 }),
  });
  if (!r.ok) throw new Error("Vision analyze failed");
  return r.json();
}

export async function voiceTranscribe(audioBase64: string, language = "en"): Promise<{
  text: string;
  language: string;
  provider: string;
  note?: string;
}> {
  const r = await backendFetch(`/api/voice/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio_base64: audioBase64, language }),
  });
  if (!r.ok) throw new Error("Voice transcription failed");
  return r.json();
}


export async function codeAnalyze(content: string, language: string): Promise<{
  language: string;
  summary: { issue_count: number; high: number; medium: number; low: number };
  summary_text: string;
  issues: Array<{ line: number | null; severity: string; type: string; message: string }>;
}> {
  const r = await backendFetch(`/api/code/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, language }),
  });
  if (!r.ok) throw new Error("Code analysis failed");
  return r.json();
}

export async function fetchIntegrationFlags(): Promise<{
  browser_bridge: boolean;
  vscode_bridge: boolean;
}> {
  const r = await backendFetch(`/api/integrations/flags`);
  if (!r.ok) throw new Error("Failed to load integration flags");
  return r.json();
}

export type PlanId = "free" | "premium" | "ultra";

export interface PlanInfo {
  plan: PlanId;
  name: string;
  model: string;
  price: string;
  context: string;
}

export async function fetchPlan(): Promise<PlanInfo> {
  const r = await backendFetch(`/api/plan`);
  if (!r.ok) throw new Error("Failed to fetch plan");
  return r.json();
}

export async function setPlan(plan: PlanId): Promise<PlanInfo> {
  const r = await backendFetch(`/api/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  });
  if (!r.ok) throw new Error("Failed to set plan");
  return r.json();
}

export interface QuickToolItem {
  id: string;
  label: string;
  section: string;
}

export async function fetchQuickTools(): Promise<{ items: QuickToolItem[] }> {
  const r = await backendFetch(`/api/quick-tools/list`);
  if (!r.ok) throw new Error("Failed to fetch quick tools");
  return r.json();
}

export async function runQuickTool(
  toolId: string,
  text: string,
  options?: Record<string, unknown>,
  context?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const r = await backendFetch(`/api/quick-tools/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool_id: toolId, text, options: options ?? {}, context: context ?? {} }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Quick tool failed");
  }
  return r.json();
}

export async function fetchSlackChannels(): Promise<{ items: Array<{ id: string; name: string }> }> {
  const r = await backendFetch(`/api/integrations/slack/channels`);
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Failed to fetch Slack channels");
  }
  return r.json();
}

export async function sendSlackMessage(text: string, channel?: string): Promise<Record<string, unknown>> {
  const r = await backendFetch(`/api/integrations/slack/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, channel: channel ?? "" }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Failed to send Slack message");
  }
  return r.json();
}

export async function reviewGitHubPR(repoOrUrl: string, prNumber?: number): Promise<Record<string, unknown>> {
  const r = await backendFetch(`/api/integrations/github/pr-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo_or_url: repoOrUrl, pr_number: prNumber ?? null }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Failed to review PR");
  }
  return r.json();
}

export async function fetchCalendarEvents(maxResults = 20): Promise<{ items: Array<Record<string, unknown>> }> {
  const r = await backendFetch(`/api/integrations/calendar/events?max_results=${encodeURIComponent(String(maxResults))}`);
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Failed to load calendar events");
  }
  return r.json();
}

export async function getCalendarOAuthUrl(state = "sideai"): Promise<{ url: string }> {
  const r = await backendFetch(`/api/integrations/calendar/oauth/url?state=${encodeURIComponent(state)}`);
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Failed to create calendar auth url");
  }
  return r.json();
}

export async function exchangeCalendarOAuthCode(code: string): Promise<{ ok: boolean; token_type: string; expires_in: number }> {
  const r = await backendFetch(`/api/integrations/calendar/oauth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Failed to exchange calendar auth code");
  }
  return r.json();
}

export async function refreshCalendarOAuth(): Promise<{ ok: boolean; token_type: string; expires_in: number }> {
  const r = await backendFetch(`/api/integrations/calendar/oauth/refresh`, { method: "POST" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Failed to refresh calendar token");
  }
  return r.json();
}

export async function createCalendarEvent(payload: {
  summary: string;
  start_iso: string;
  end_iso: string;
  description?: string;
  timezone?: string;
  attendee_emails?: string[];
}): Promise<Record<string, unknown>> {
  const r = await backendFetch(`/api/integrations/calendar/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: payload.summary,
      start_iso: payload.start_iso,
      end_iso: payload.end_iso,
      description: payload.description ?? "",
      timezone: payload.timezone ?? "UTC",
      attendee_emails: payload.attendee_emails ?? [],
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Failed to create calendar event");
  }
  return r.json();
}

export interface AnalyticsSummary {
  total_events: number;
  top_tools: Array<{ tool_id: string; count: number }>;
  top_event_types: Array<{ event_type: string; count: number }>;
}

export async function fetchAnalyticsSummary(limit = 20): Promise<AnalyticsSummary> {
  const r = await backendFetch(`/api/analytics/summary?limit=${encodeURIComponent(String(limit))}`);
  if (!r.ok) throw new Error("Failed to load analytics summary");
  return r.json();
}

export async function logAnalyticsEvent(payload: {
  event_type: string;
  tool_id?: string;
  payload?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const r = await backendFetch(`/api/analytics/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type: payload.event_type,
      tool_id: payload.tool_id ?? "",
      payload: payload.payload ?? {},
    }),
  });
  if (!r.ok) throw new Error("Failed to log analytics event");
  return r.json();
}

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  level: string;
  read: boolean;
  dismissed: boolean;
  created_at: string;
}

export async function fetchNotifications(includeDismissed = false): Promise<{ items: NotificationItem[] }> {
  const r = await backendFetch(`/api/notifications?include_dismissed=${includeDismissed ? "true" : "false"}`);
  if (!r.ok) throw new Error("Failed to fetch notifications");
  return r.json();
}

export async function createNotification(payload: { title: string; body?: string; level?: string }): Promise<NotificationItem> {
  const r = await backendFetch(`/api/notifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: payload.title, body: payload.body ?? "", level: payload.level ?? "info" }),
  });
  if (!r.ok) throw new Error("Failed to create notification");
  return r.json();
}

export async function updateNotification(
  notificationId: string,
  payload: { read?: boolean; dismissed?: boolean }
): Promise<NotificationItem> {
  const r = await backendFetch(`/api/notifications/${encodeURIComponent(notificationId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ read: payload.read, dismissed: payload.dismissed }),
  });
  if (!r.ok) throw new Error("Failed to update notification");
  return r.json();
}


export async function startFocusTimer(durationMinutes: number): Promise<{ id: string; duration_minutes: number; status: string; started_at: string; ended_at?: string | null }> {
  const r = await backendFetch(`/api/focus/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ duration_minutes: durationMinutes }),
  });
  if (!r.ok) throw new Error("Failed to start focus timer");
  return r.json();
}

export async function completeFocusTimer(timerId: string): Promise<{ id: string; duration_minutes: number; status: string; started_at: string; ended_at?: string | null }> {
  const r = await backendFetch(`/api/focus/${encodeURIComponent(timerId)}/complete`, { method: "POST" });
  if (!r.ok) throw new Error("Failed to complete focus timer");
  return r.json();
}

export async function fetchLatestFocusTimer(): Promise<{ item: { id: string; duration_minutes: number; status: string; started_at: string; ended_at?: string | null } | null }> {
  const r = await backendFetch(`/api/focus/latest`);
  if (!r.ok) throw new Error("Failed to fetch latest focus timer");
  return r.json();
}

// ---- Daily-life: brief, weather, lists, daily note ----
export interface DailyBrief {
  date: string;
  calendar_today: Array<Record<string, unknown>>;
  reminders: ReminderItem[];
  weather: { temp_C?: string; temp_F?: string; desc?: string; location?: string; error?: string };
}

export async function fetchDailyBrief(city = ""): Promise<DailyBrief> {
  const q = city ? `?city=${encodeURIComponent(city)}` : "";
  const r = await backendFetch(`/api/daily-brief${q}`);
  if (!r.ok) throw new Error("Failed to load daily brief");
  return r.json();
}

export async function fetchWeather(city = ""): Promise<{ temp_C?: string; temp_F?: string; desc?: string; location?: string }> {
  const q = city ? `?city=${encodeURIComponent(city)}` : "";
  const r = await backendFetch(`/api/weather${q}`);
  if (!r.ok) throw new Error("Failed to load weather");
  return r.json();
}


export async function fetchDailyNote(dateIso?: string): Promise<{ date_iso: string; content: string; updated_at: string | null }> {
  const q = dateIso ? `?date_iso=${encodeURIComponent(dateIso)}` : "";
  const r = await backendFetch(`/api/daily-note${q}`);
  if (!r.ok) throw new Error("Failed to load daily note");
  return r.json();
}

export async function saveDailyNote(dateIso: string, content: string): Promise<{ date_iso: string; content: string; updated_at: string }> {
  const r = await backendFetch(`/api/daily-note`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date_iso: dateIso, content }),
  });
  if (!r.ok) throw new Error("Failed to save daily note");
  return r.json();
}

// ---- Grocery: detect product on screen, find cheaper, copy link ----
export interface ShoppingAlternative {
  title: string;
  url: string;
  price_text?: string;
}

export interface FindCheaperResult {
  detected: boolean;
  reason?: string;
  product_query?: string;
  alternatives: ShoppingAlternative[];
  best_link: string | null;
  cached?: boolean;
}

export async function findCheaperAlternatives(context?: Record<string, unknown>): Promise<FindCheaperResult> {
  const r = await backendFetch(`/api/shopping/find-cheaper`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: context ?? null }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "Failed to find cheaper");
  }
  return r.json();
}

export const apiClients = {
  chat: { sendChat, sendChatStream, typeText, captureNow, fetchContext, fetchSuggestions },
  conversations: { createConversation, fetchConversations, fetchConversation, addConversationMessage, exportConversation, searchHistory, setConversationMemoryMode },
  templates: { fetchTemplates, createTemplate, deleteTemplate, importTemplates, saveWorkflowFromResponse },
  settings: { fetchSettings, patchSetting, fetchHotkeys, createHotkey, deleteHotkey },
  actions: { searchWeb, synthesizeAnswer, saveFavoriteResponse, fetchFavoriteResponses, analyzeClipboard, annotateImage, verifyChatAnswer },
  phase3: { ingestKBDocument, listKBDocuments, queryKB, visionAnalyze, voiceTranscribe, codeAnalyze },
  integrations: {
    fetchIntegrationFlags,
    fetchSlackChannels,
    sendSlackMessage,
    reviewGitHubPR,
    fetchCalendarEvents,
    createCalendarEvent,
    getCalendarOAuthUrl,
    exchangeCalendarOAuthCode,
    refreshCalendarOAuth,
  },
  quickTools: { fetchQuickTools, runQuickTool },
  analytics: { fetchAnalyticsSummary, logAnalyticsEvent },
  notifications: { fetchNotifications, createNotification, updateNotification },
  productivity: { startFocusTimer, completeFocusTimer, fetchLatestFocusTimer },
  dailyLife: {
    fetchDailyBrief,
    fetchWeather,
    fetchDailyNote,
    saveDailyNote,
    fetchReminders,
    createReminder,
    setReminderDone,
    snoozeReminder,
  },
  shopping: { findCheaperAlternatives },
};
