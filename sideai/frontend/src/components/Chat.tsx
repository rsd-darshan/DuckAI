import { useEffect, useRef, useState } from "react";
import { SaveToNotionButton } from "./NotionConfig";
import type { ChatMessage } from "../hooks/useBackend";
import {
  integrationJiraIssue,
  integrationLinearIssue,

  integrationObsidianAppend,
  saveFavoriteResponse,
  saveWorkflowFromResponse,
  type ResponseVerification,
  typeText,
  verifyChatAnswer,
} from "../hooks/useBackend";
import { useWordByWordText } from "../hooks/useWordByWordText";
import { buildChatMarkdownExport, downloadTextFile } from "../utils/transcriptExport";
import { renderMarkdownAnswer } from "../utils/renderMarkdownLite";

const QUICK_PROMPTS: Array<{ label: string; icon: string; prompt: string }> = [
  { label: "Summarize", icon: "📋", prompt: "Summarize what is visible on my screen in 3 short bullet points." },
  { label: "What's this?", icon: "👀", prompt: "What am I looking at? Name the app or site and the main content." },
  { label: "Explain it", icon: "💡", prompt: "Explain the main content on my screen simply, as if teaching a friend." },
  { label: "Draft reply", icon: "✉️", prompt: "Draft a short, polite reply I could send based on what is on my screen." },
];

const THINKING_PHRASES = ["Thinking…", "Analyzing your screen…", "Writing…", "Almost there…"];


interface ChatProps {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  emptyMessage?: string;
  offlineQueueSize?: number;
  onClear?: () => void;
  appContext?: string;
  onQuickAction?: (prompt: string) => void;
  sources?: Array<{ title: string; url: string; snippet: string }> | null;
  /** Focused window / tab title from screen context (helps user verify what the AI “sees”). */
  windowTitle?: string;
  onStop?: () => void;
  onRetry?: () => void;
  onRetryOfflineQueue?: () => void;
  onDismissOfflineQueue?: () => void;
  memoryMode?: "this_chat_only" | "remember_24h" | "never_remember";
  onMemoryModeChange?: (mode: "this_chat_only" | "remember_24h" | "never_remember") => void;
  conversationId?: string | null;
  /** Per-thread: when true, backend includes live screen OCR in chat requests. */
  useScreenContext?: boolean;
  onUseScreenContextChange?: (value: boolean) => void;
}

export function Chat({
  messages,
  loading,
  error,
  emptyMessage = "Ask anything. I see your screen and can help in real time.",
  offlineQueueSize = 0,
  onClear,
  appContext = "",
  onQuickAction,
  sources,
  windowTitle,
  onStop,
  onRetry,
  onRetryOfflineQueue,
  onDismissOfflineQueue,
  memoryMode = "this_chat_only",
  onMemoryModeChange,
  conversationId,
  useScreenContext = true,
  onUseScreenContextChange,
}: ChatProps) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [writingIndex, setWritingIndex] = useState<number | null>(null);
  const [savedIndex, setSavedIndex] = useState<number | null>(null);
  const [copiedTranscript, setCopiedTranscript] = useState(false);
  const [exportedMd, setExportedMd] = useState(false);
  const [verifyingIndex, setVerifyingIndex] = useState<number | null>(null);
  const [verifiedByIndex, setVerifiedByIndex] = useState<Record<number, ResponseVerification>>({});
  const [savingWorkflowIndex, setSavingWorkflowIndex] = useState<number | null>(null);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [showMoreControls, setShowMoreControls] = useState(false);
  const [thinkingPhraseIdx, setThinkingPhraseIdx] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const lastAssistantReply = getLastAssistantExportable(messages);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // Cycle thinking phrases while loading
  useEffect(() => {
    if (!loading) { setThinkingPhraseIdx(0); return; }
    const id = setInterval(() => setThinkingPhraseIdx((i) => (i + 1) % THINKING_PHRASES.length), 1800);
    return () => clearInterval(id);
  }, [loading]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, loading]);

  const copyMessage = (content: string, index: number) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    });
  };

  const writeToScreen = async (content: string, index: number) => {
    setWritingIndex(index);
    try {
      // For manual \"Write it\", also type character-by-character.
      await typeText(content, { method: "type", delaySeconds: 1.5 });
    } catch (_) {
      copyMessage(content, index);
    } finally {
      setWritingIndex(null);
    }
  };

  const saveResponse = async (content: string, index: number) => {
    try {
      await saveFavoriteResponse({ content, app_context: appContext });
      setSavedIndex(index);
      setTimeout(() => setSavedIndex(null), 2000);
    } catch (_) {}
  };

  const copyTranscript = () => {
    if (messages.length === 0) return;
    const lines = messages.map((m) => {
      const who = m.role === "user" ? "User" : "Assistant";
      return `${who}: ${m.content}`;
    });
    navigator.clipboard.writeText(lines.join("\n\n")).then(() => {
      setCopiedTranscript(true);
      setTimeout(() => setCopiedTranscript(false), 2000);
    });
  };

  const exportMarkdownFile = () => {
    if (messages.length === 0) return;
    const md = buildChatMarkdownExport({
      messages,
      sources: sources ?? null,
      appContext,
      windowTitle,
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadTextFile(`sideai-chat-${stamp}.md`, md);
    setExportedMd(true);
    setTimeout(() => setExportedMd(false), 2000);
  };

  const findPreviousUserPrompt = (idx: number): string => {
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") return messages[i].content;
    }
    return "";
  };

  const verifyMessage = async (content: string, index: number) => {
    const question = findPreviousUserPrompt(index);
    setVerifyingIndex(index);
    try {
      const out = await verifyChatAnswer({
        question: question || "Validate this answer",
        answer: content,
        conversation_id: conversationId ?? undefined,
      });
      setVerifiedByIndex((prev) => ({ ...prev, [index]: out.verification }));
    } catch (_) {
      // ignore, existing error surfaces in chat stream area if needed
    } finally {
      setVerifyingIndex(null);
    }
  };

  const toggleSpeak = (plain: string, index: number) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    if (speakingIndex === index) {
      window.speechSynthesis.cancel();
      setSpeakingIndex(null);
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(plain.slice(0, 32000));
    u.onend = () => setSpeakingIndex(null);
    u.onerror = () => setSpeakingIndex(null);
    setSpeakingIndex(index);
    window.speechSynthesis.speak(u);
  };

  const sendLastToObsidian = async () => {
    const text = lastAssistantReply;
    if (!text) return;
    const rel =
      window.prompt("Vault-relative path (default DuckAI-inbox.md)", "DuckAI-inbox.md")?.trim() || "DuckAI-inbox.md";
    try {
      await integrationObsidianAppend(rel, text);
      window.alert("Appended to Obsidian file.");
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Obsidian request failed");
    }
  };

  const sendLastToLinear = async () => {
    const text = lastAssistantReply;
    if (!text) return;
    const title = window.prompt("Linear issue title");
    if (!title?.trim()) return;
    try {
      const out = await integrationLinearIssue(title.trim(), text.slice(0, 12000));
      window.alert(`Linear: ${JSON.stringify(out).slice(0, 400)}`);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Linear request failed");
    }
  };

  const sendLastToJira = async () => {
    const text = lastAssistantReply;
    if (!text) return;
    const summary = window.prompt("Jira issue summary");
    if (!summary?.trim()) return;
    try {
      const out = await integrationJiraIssue(summary.trim(), text.slice(0, 12000));
      window.alert(`Jira: ${JSON.stringify(out).slice(0, 400)}`);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Jira request failed");
    }
  };

  const saveAsWorkflow = async (content: string, index: number) => {
    setSavingWorkflowIndex(index);
    try {
      await saveWorkflowFromResponse({
        name: `Workflow ${new Date().toLocaleTimeString()}`,
        response_text: content,
        description: "Saved from chat response",
        tags: ["workflow"],
      });
      setSavedIndex(index);
      setTimeout(() => setSavedIndex(null), 2000);
    } catch (_) {
      // ignore
    } finally {
      setSavingWorkflowIndex(null);
    }
  };

  return (
    <section
      className="flex-1 min-h-0 flex flex-col overflow-hidden"
      aria-label="Chat"
    >
      {/* ── Compact chat toolbar ── */}
      <div className="shrink-0 border-b border-panel-border bg-panel-bg-elevated/60 backdrop-blur-sm">
        <div className="flex items-center gap-1.5 px-3 py-1.5">
          {/* Screen context toggle */}
          {onUseScreenContextChange && (
            <button
              type="button"
              onClick={() => onUseScreenContextChange(!useScreenContext)}
              title={`Screen context ${useScreenContext ? "on" : "off"}${windowTitle ? ` — ${windowTitle}` : ""}`}
              className="focus-ring flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium motion-safe:transition-surface"
              style={{
                color: useScreenContext ? "var(--panel-accent)" : "var(--panel-muted)",
                background: useScreenContext
                  ? "color-mix(in srgb, var(--panel-accent) 8%, transparent)"
                  : "transparent",
                border: useScreenContext
                  ? "1px solid color-mix(in srgb, var(--panel-accent) 20%, transparent)"
                  : "1px solid transparent",
              }}
            >
              <MonitorIcon />
              <span>Screen</span>
            </button>
          )}

          {/* Context badge — shows what DuckAI is currently reading */}
          {useScreenContext && windowTitle && (
            <div
              className="flex items-center gap-1 min-w-0 max-w-[140px] px-1.5 py-0.5 rounded-md"
              title={windowTitle}
              style={{
                background: "color-mix(in srgb, var(--panel-border) 50%, transparent)",
                border: "1px solid var(--panel-border)",
              }}
            >
              <EyeIcon />
              <span
                className="text-[9.5px] truncate leading-none"
                style={{ color: "var(--panel-muted)" }}
              >
                {windowTitle.length > 28 ? windowTitle.slice(0, 26) + "…" : windowTitle}
              </span>
            </div>
          )}

          <div className="flex-1" />

          {/* Stop when streaming */}
          {loading && onStop && (
            <button
              type="button"
              onClick={onStop}
              className="focus-ring text-[11px] font-medium rounded-md px-2.5 py-1 motion-safe:transition-surface"
              style={{
                color: "var(--semantic-danger-text)",
                background: "var(--semantic-danger-bg)",
                border: "1px solid var(--semantic-danger-border)",
              }}
            >
              Stop
            </button>
          )}

          {/* More controls toggle */}
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setShowMoreControls((v) => !v)}
              title="More options"
              className="focus-ring h-7 w-7 flex items-center justify-center rounded-md motion-safe:transition-surface"
              style={{
                color: showMoreControls ? "var(--panel-text)" : "var(--panel-muted)",
                background: showMoreControls ? "var(--panel-surface-hover)" : "transparent",
                border: "1px solid transparent",
              }}
            >
              <DotsIcon />
            </button>
          )}
        </div>

        {/* Expanded controls drawer */}
        {showMoreControls && messages.length > 0 && (
          <div className="px-3 pb-2.5 pt-1 flex flex-wrap gap-1.5 border-t border-panel-border/50">
            {onMemoryModeChange && (
              <select
                value={memoryMode}
                onChange={(e) => onMemoryModeChange(e.target.value as "this_chat_only" | "remember_24h" | "never_remember")}
                className="focus-ring text-[10px] rounded-md border border-panel-border bg-panel-surface px-2 py-1 text-panel-muted"
                title="Session memory mode"
              >
                <option value="this_chat_only">This chat only</option>
                <option value="remember_24h">Remember 24h</option>
                <option value="never_remember">Never remember</option>
              </select>
            )}
            <button
              type="button"
              onClick={copyTranscript}
              className="focus-ring text-[10px] font-medium rounded-md border border-panel-border bg-panel-surface px-2 py-1 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface"
            >
              {copiedTranscript ? "Copied!" : "Copy chat"}
            </button>
            <button
              type="button"
              onClick={exportMarkdownFile}
              className="focus-ring text-[10px] font-medium rounded-md border border-panel-border bg-panel-surface px-2 py-1 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface"
            >
              {exportedMd ? "Saved!" : "Export .md"}
            </button>
            {onClear && (
              <button
                type="button"
                onClick={() => { onClear(); setShowMoreControls(false); }}
                className="focus-ring text-[10px] font-medium rounded-md border border-panel-border bg-panel-surface px-2 py-1 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface"
              >
                Clear chat
              </button>
            )}
            {!loading && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="focus-ring text-[10px] font-medium rounded-md border border-panel-border bg-panel-surface px-2 py-1 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface"
              >
                Retry
              </button>
            )}
            {lastAssistantReply && (
              <>
                <div className="w-full h-px" style={{ background: "var(--panel-border)", opacity: 0.5 }} />
                <span className="text-[9px] font-semibold uppercase tracking-wider text-panel-muted w-full">Export last reply</span>
                <SaveToNotionButton
                  title={(messages.find(m => m.role === "user")?.content ?? "DuckAI Answer").slice(0, 80)}
                  content={lastAssistantReply}
                />
                <button type="button" onClick={() => void sendLastToObsidian()} className="focus-ring text-[10px] font-medium rounded-md border border-panel-border bg-panel-surface px-2 py-1 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface">Obsidian</button>
                <button type="button" onClick={() => void sendLastToLinear()} className="focus-ring text-[10px] font-medium rounded-md border border-panel-border bg-panel-surface px-2 py-1 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface">Linear</button>
                <button type="button" onClick={() => void sendLastToJira()} className="focus-ring text-[10px] font-medium rounded-md border border-panel-border bg-panel-surface px-2 py-1 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface">Jira</button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-4 min-h-0 bg-gradient-to-b from-transparent to-panel-bg/30">
        {sources && sources.length > 0 && (
          <div className="rounded-xl border border-panel-border bg-panel-surface p-3 space-y-2 shadow-panel motion-safe:transition-surface">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-panel-muted">Sources</p>
            <div className="space-y-2">
              {sources.map((h, idx) => (
                <a
                  key={`${h.url}-${idx}`}
                  href={h.url}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-ring block rounded-lg border border-panel-border bg-panel-bg/40 p-2.5 hover:border-panel-accent/35 hover:shadow-panel motion-safe:transition-surface"
                >
                  <p className="text-xs font-medium text-[color:var(--panel-text)] line-clamp-2">{h.title}</p>
                  <p className="text-[11px] text-panel-muted mt-0.5 line-clamp-2">{h.snippet}</p>
                </a>
              ))}
            </div>
          </div>
        )}
        {error && (
          <div
            className="rounded-bubble border text-sm p-3 shadow-panel motion-safe:transition-surface space-y-2"
            style={{
              backgroundColor: "var(--semantic-danger-bg)",
              borderColor: "var(--semantic-danger-border)",
              color: "var(--semantic-danger-text)",
            }}
            role="alert"
          >
            <p className="leading-relaxed">{error}</p>
            {!loading && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="focus-ring text-xs font-semibold rounded-md border border-current/30 px-2.5 py-1.5 hover:bg-black/5 dark:hover:bg-white/10 motion-safe:transition-surface"
              >
                Try again
              </button>
            )}
          </div>
        )}
        {offlineQueueSize > 0 && (
          <div
            className="rounded-bubble border text-xs p-3 shadow-panel space-y-2"
            style={{
              backgroundColor: "var(--semantic-warn-bg)",
              borderColor: "var(--semantic-warn-border)",
              color: "var(--semantic-warn-text)",
            }}
            role="status"
          >
            <p>
              {offlineQueueSize} queued request{offlineQueueSize > 1 ? "s" : ""} pending retry (auto-retry every few seconds
              when the backend is up).
            </p>
            <div className="flex flex-wrap gap-2">
              {onRetryOfflineQueue && (
                <button
                  type="button"
                  onClick={onRetryOfflineQueue}
                  className="focus-ring rounded-md border border-amber-700/40 bg-panel-bg/50 px-2 py-1 text-[11px] font-semibold text-[color:var(--panel-text)] hover:bg-panel-bg motion-safe:transition-surface"
                >
                  Retry now
                </button>
              )}
              {onDismissOfflineQueue && (
                <button
                  type="button"
                  onClick={onDismissOfflineQueue}
                  className="focus-ring rounded-md border border-panel-border bg-transparent px-2 py-1 text-[11px] font-medium text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface"
                >
                  Clear queue
                </button>
              )}
            </div>
          </div>
        )}
        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center gap-4 px-4 py-8 animate-fade-up">
            {/* Brand mark */}
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center"
              style={{
                background: "linear-gradient(135deg, color-mix(in srgb, var(--panel-accent) 18%, transparent), color-mix(in srgb, var(--panel-accent-2,#a855f7) 12%, transparent))",
                border: "1px solid color-mix(in srgb, var(--panel-accent) 25%, var(--panel-border))",
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" fill="var(--panel-accent)" opacity="0.9"/>
                <path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z" stroke="var(--panel-accent)" strokeWidth="1.5" fill="none" opacity="0.3"/>
              </svg>
            </div>

            <div className="text-center space-y-1">
              <p className="text-sm font-medium" style={{ color: "var(--panel-text)" }}>
                What can I help with?
              </p>
              <p className="text-[12px] leading-relaxed max-w-[240px] mx-auto" style={{ color: "var(--panel-muted)" }}>
                {emptyMessage}
              </p>
            </div>

            {onQuickAction && (
              <div className="grid grid-cols-2 gap-1.5 w-full max-w-[280px]">
                {QUICK_PROMPTS.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => onQuickAction(q.prompt)}
                    className="focus-ring flex items-center gap-2 rounded-xl border border-panel-border bg-panel-surface/60 px-3 py-2.5 text-left motion-safe:transition-surface hover:border-panel-accent/30 hover:bg-panel-surface"
                    style={{ color: "var(--panel-text)" }}
                  >
                    <span className="text-base leading-none">{q.icon}</span>
                    <span className="text-[11px] font-medium">{q.label}</span>
                  </button>
                ))}
              </div>
            )}

            <p className="text-[10px] leading-snug text-center max-w-[240px]" style={{ color: "var(--panel-muted)", opacity: 0.7 }}>
              Tip: type <code className="rounded px-1 py-0.5" style={{ background: "var(--panel-border)", opacity: 0.9 }}>/search …</code> to search the web
            </p>
          </div>
        )}
        {messages.map((msg, i) => {
          const isMetaAssistant =
            msg.role === "assistant" &&
            (msg.content.startsWith("Wrote to screen:") ||
              msg.content.startsWith("Copied to clipboard."));
          const streamThisBubble =
            loading && msg.role === "assistant" && i === messages.length - 1 && !isMetaAssistant;
          return (
            <div
              key={msg.id ?? `idx-${i}`}
              className={`flex animate-msg-in ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              style={{ animationDelay: `${Math.min(i * 20, 80)}ms` }}
            >
              <div
                className={`group relative max-w-[90%] rounded-bubble px-4 py-3 text-sm leading-relaxed motion-safe:transition-surface ${
                  msg.role === "user"
                    ? "shadow-panel-md ring-1 ring-black/5"
                    : "bg-panel-surface border border-panel-border text-[color:var(--panel-text)] shadow-panel"
                }`}
                style={msg.role === "user" ? {
                  background: "linear-gradient(135deg, var(--panel-accent), color-mix(in srgb, var(--panel-accent-2,#a855f7) 40%, var(--panel-accent)))",
                  color: "var(--accent-text)",
                } : undefined}
              >
                <div className="break-words pr-[4.5rem]">
                  {msg.role === "assistant" && !isMetaAssistant ? (
                    <AssistantMessageMarkdown content={msg.content} streamActive={streamThisBubble} />
                  ) : (
                    renderMarkdownAnswer(msg.content)
                  )}
                </div>
                {msg.role === "assistant" && !isMetaAssistant && (
                  <div className="absolute top-2 right-2 flex gap-0.5 opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 motion-safe:transition-opacity">
                    <button
                      type="button"
                      onClick={() => toggleSpeak(plainTextForSpeech(msg.content), i)}
                      className="focus-ring p-1.5 rounded-lg hover:bg-panel-border/60 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface"
                      aria-label={speakingIndex === i ? "Stop speaking" : "Read aloud"}
                      title={speakingIndex === i ? "Stop" : "Read aloud"}
                    >
                      {speakingIndex === i ? <span className="text-xs">■</span> : <SpeakerIcon />}
                    </button>
                    <button
                      type="button"
                      onClick={() => writeToScreen(msg.content, i)}
                      disabled={writingIndex !== null}
                      className="focus-ring p-1.5 rounded-lg hover:bg-panel-border/60 text-panel-muted hover:text-[color:var(--panel-text)] disabled:opacity-50 motion-safe:transition-surface"
                      aria-label="Write to screen"
                      title="Write to focused field (e.g. reply box)"
                    >
                      {writingIndex === i ? <span className="text-xs">...</span> : <PencilIcon />}
                    </button>
                    <button
                      type="button"
                      onClick={() => copyMessage(msg.content, i)}
                      className="focus-ring p-1.5 rounded-lg hover:bg-panel-border/60 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface"
                      aria-label="Copy"
                      title="Copy"
                    >
                      {copiedIndex === i ? <CheckIcon /> : <CopyIcon />}
                    </button>
                    <button
                      type="button"
                      onClick={() => saveResponse(msg.content, i)}
                      className="focus-ring p-1.5 rounded-lg hover:bg-panel-border/60 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface"
                      aria-label="Save response"
                      title="Save to favorites"
                    >
                      {savedIndex === i ? <CheckIcon /> : <StarIcon />}
                    </button>
                    <button
                      type="button"
                      onClick={() => verifyMessage(msg.content, i)}
                      className="focus-ring p-1.5 rounded-lg hover:bg-panel-border/60 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface"
                      aria-label="Verify with sources"
                      title="Verify with sources"
                    >
                      {verifyingIndex === i ? <span className="text-xs">...</span> : <ShieldIcon />}
                    </button>
                    <button
                      type="button"
                      onClick={() => saveAsWorkflow(msg.content, i)}
                      className="focus-ring p-1.5 rounded-lg hover:bg-panel-border/60 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface"
                      aria-label="Save as workflow"
                      title="Save as workflow"
                    >
                      {savingWorkflowIndex === i ? <span className="text-xs">...</span> : <FlowIcon />}
                    </button>
                    <button
                      type="button"
                      onClick={() => onQuickAction?.(`Search the web and summarize this: ${msg.content.slice(0, 200)}`)}
                      className="focus-ring p-1.5 rounded-lg hover:bg-panel-border/60 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface"
                      aria-label="Search from response"
                      title="Search related sources"
                    >
                      <GlobeIcon />
                    </button>
                    <button
                      type="button"
                      onClick={() => onQuickAction?.(`Write a concise follow-up based on this response: ${msg.content.slice(0, 300)}`)}
                      className="focus-ring p-1.5 rounded-lg hover:bg-panel-border/60 text-panel-muted hover:text-[color:var(--panel-text)] motion-safe:transition-surface"
                      aria-label="Generate follow-up"
                      title="Generate follow-up"
                    >
                      <ReplyIcon />
                    </button>
                  </div>
                )}
                {msg.role === "assistant" && !isMetaAssistant && verifiedByIndex[i] && (
                  <div className="mt-2 space-y-1">
                    <div className="text-[10px] text-panel-muted">
                      Verification:{" "}
                      <span className={verifiedByIndex[i].verified ? "text-emerald-600" : "text-amber-600"}>
                        {verifiedByIndex[i].verified ? "verified" : "needs review"}
                      </span>
                    </div>
                    {verifiedByIndex[i]?.contradictions?.length ? (
                      <div className="text-[10px] rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1">
                        {verifiedByIndex[i].contradictions!.slice(0, 2).join(" | ")}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {loading && (
          <div className="flex justify-start animate-msg-in">
            <div
              className="rounded-bubble px-4 py-3 bg-panel-surface border border-panel-border shadow-panel flex items-center gap-3"
              aria-live="polite"
              aria-label="DuckAI is thinking"
            >
              <span className="flex gap-1 items-center">
                <span className="thinking-dot" />
                <span className="thinking-dot" />
                <span className="thinking-dot" />
              </span>
              <span className="text-sm font-medium transition-all duration-300" style={{ color: "var(--panel-muted)" }}>
                {THINKING_PHRASES[thinkingPhraseIdx]}
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
    </section>
  );
}

function getLastAssistantExportable(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const c = (m.content || "").trim();
    if (
      !c ||
      c.startsWith("Typing:") ||
      c.startsWith("Wrote to screen:") ||
      c.startsWith("Copied to clipboard.") ||
      c.startsWith("Offline detected.") ||
      c.startsWith("Request failed:") ||
      c.startsWith("Web search failed:")
    ) {
      continue;
    }
    return m.content;
  }
  return null;
}

function plainTextForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/^#{1,6}\s?/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function AssistantMessageMarkdown({ content, streamActive }: { content: string; streamActive: boolean }) {
  const { displayText, usePlainText } = useWordByWordText(content, { active: streamActive });
  if (usePlainText) {
    return (
      <span className="whitespace-pre-wrap text-[color:var(--panel-text)]" aria-busy="true">
        {displayText}
      </span>
    );
  }
  return renderMarkdownAnswer(content);
}

function MonitorIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3" aria-hidden>
      <path fillRule="evenodd" d="M1.75 2.5a.75.75 0 0 0 0 1.5h.75v7.25a.75.75 0 0 0 .75.75h3.5v.75h-1a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-1V12h3.5a.75.75 0 0 0 .75-.75V4h.75a.75.75 0 0 0 0-1.5h-12.5ZM4 4h8v6.5H4V4Z" clipRule="evenodd" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0" aria-hidden>
      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
      <path fillRule="evenodd" d="M1.38 8a6.978 6.978 0 0 1 1.215-2.668 7 7 0 0 1 10.81 0A6.978 6.978 0 0 1 14.62 8a6.978 6.978 0 0 1-1.215 2.668 7 7 0 0 1-10.81 0A6.978 6.978 0 0 1 1.38 8ZM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
      <path d="M2 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM6.5 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM11 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H6a1.5 1.5 0 0 1-1.5-1.5v-4.5A1.5 1.5 0 0 1 6 8.25Z"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
      <path d="M7.5 3.375c0-1.036.84-1.875 1.875-1.875h.375a3.75 3.75 0 0 1 3.75 3.75v1.875C13.5 8.161 14.34 9 15.375 9h1.875A3.75 3.75 0 0 1 21 12.75v3.375C21 17.16 20.16 18 19.125 18h-9.75A1.875 1.875 0 0 1 7.5 16.125V3.375Z" />
      <path d="M15 5.25a5.23 5.23 0 0 0-1.279-3.434 9.768 9.768 0 0 1 6.963 6.963A5.23 5.23 0 0 0 17.25 7.5h-1.875A.375.375 0 0 1 15 7.125V5.25ZM4.875 6H6v10.125A3.375 3.375 0 0 0 9.375 19.5H16.5v1.125c0 1.035-.84 1.875-1.875 1.875h-9.75A1.875 1.875 0 0 1 3 18.375V7.875C3 6.839 3.84 6 4.875 6Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 text-emerald-400" aria-hidden>
      <path fillRule="evenodd" d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.74a.75.75 0 0 1 1.04-.207Z" clipRule="evenodd" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
      <path d="M21.731 2.269a2.625 2.625 0 0 0-3.712 0l-1.157 1.157 3.712 3.712 1.157-1.157a2.625 2.625 0 0 0 0-3.712ZM19.513 8.199l-3.712-3.712-8.4 8.4a5.25 5.25 0 0 0-1.32 2.214l-.8 2.685a.75.75 0 0 0 .933.933l2.685-.8a5.25 5.25 0 0 0 2.214-1.32l8.4-8.4Z" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
      <path
        fillRule="evenodd"
        d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354l-4.627 2.826c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
      <path fillRule="evenodd" d="M14.25 2.25a.75.75 0 0 1 .75.75v1.409A8.26 8.26 0 0 1 18.87 6h1.38a.75.75 0 0 1 0 1.5h-.54a8.226 8.226 0 0 1 0 9h.54a.75.75 0 0 1 0 1.5h-1.38A8.26 8.26 0 0 1 15 19.591V21a.75.75 0 0 1-1.5 0v-1.409A8.26 8.26 0 0 1 9.63 18H8.25a.75.75 0 0 1 0-1.5h.54a8.226 8.226 0 0 1 0-9h-.54a.75.75 0 0 1 0-1.5h1.38A8.26 8.26 0 0 1 13.5 4.409V3a.75.75 0 0 1 .75-.75ZM6.75 12a6.75 6.75 0 1 0 13.5 0 6.75 6.75 0 0 0-13.5 0Z" clipRule="evenodd" />
    </svg>
  );
}

function ReplyIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
      <path fillRule="evenodd" d="M9.47 4.72a.75.75 0 0 1 1.06 0l6 6a.75.75 0 0 1 0 1.06l-6 6a.75.75 0 1 1-1.06-1.06L14.19 12 9.47 7.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
      <path d="M4.5 12a.75.75 0 0 1 .75-.75H15a.75.75 0 0 1 0 1.5H5.25A.75.75 0 0 1 4.5 12Z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
      <path fillRule="evenodd" d="M12.516 2.17a1.5 1.5 0 0 0-1.032 0l-7 2.625A1.5 1.5 0 0 0 3.5 6.2v5.26c0 4.29 2.903 8.036 7.016 9.065a1.5 1.5 0 0 0 .968 0C15.597 19.496 18.5 15.75 18.5 11.46V6.2a1.5 1.5 0 0 0-.984-1.406l-7-2.625ZM12 7.25a.75.75 0 0 1 .75.75v2.75h2.75a.75.75 0 0 1 0 1.5h-2.75V15a.75.75 0 0 1-1.5 0v-2.75H8.5a.75.75 0 0 1 0-1.5h2.75V8a.75.75 0 0 1 .75-.75Z" clipRule="evenodd" />
    </svg>
  );
}

function FlowIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
      <path d="M4.5 6.75A2.25 2.25 0 0 1 6.75 4.5h4.5a2.25 2.25 0 0 1 2.25 2.25v.75h3.75a.75.75 0 0 1 0 1.5H13.5v.75A2.25 2.25 0 0 1 11.25 12h-1.5v3h1.5A2.25 2.25 0 0 1 13.5 17.25v.75h3.75a.75.75 0 0 1 0 1.5H13.5v.75a2.25 2.25 0 0 1-2.25 2.25h-4.5A2.25 2.25 0 0 1 4.5 20.25v-3A2.25 2.25 0 0 1 6.75 15h1.5v-3h-1.5A2.25 2.25 0 0 1 4.5 9.75v-3Z" />
    </svg>
  );
}
