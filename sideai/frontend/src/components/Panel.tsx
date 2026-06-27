import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { InputBar } from "./InputBar";
import { EmailDraftPanel } from "./EmailDraftPanel";
import { SummarizePanel } from "./SummarizePanel";
import { CommandPalette, type CommandItem } from "./CommandPalette";
import { useContextPoll } from "../hooks/useContext";
import { isBrowserContext, isEmailContext } from "../utils/appContext";
import { useChat } from "../hooks/useChat";
import {
  analyzeClipboard,
  createHotkey,
  deleteHotkey,
  deleteTemplate,
  fetchBackendMeta,
  fetchHotkeys,
  importTemplates,
  type HotkeyItem,
  type ConversationItem,
  type TemplateItem,
  createTemplate,
  fetchConversation,
  fetchConversations,
  fetchSettings,
  fetchTemplates,
  getCapturePaused,
  getPrivacySettings,
  healthCheck,
  patchSetting,
  resolveAppMode,
  savePrivacySettings,
  setCapturePaused,
  fetchLastChatTransparency,
  type BackendMeta,
  type PrivacySettings,
} from "../hooks/useBackend";
import { ContextTrustBar } from "./ContextTrustBar";
import { TabLoading } from "./TabLoading";

declare global {
  interface Window {
    sideai?: {
      togglePanel?: () => void;
      onHotkeyTriggered?: (handler: (payload: { template_id?: string; key_combo?: string }) => void) => () => void;
      onClipboardChanged?: (handler: (payload: { content?: string; length?: number }) => void) => () => void;
      onFirstRun?: (handler: (payload: { isFirstRun: boolean }) => void) => () => void;
      setSidebarPosition?: (position: "left" | "right") => void;
      setPanelWidth?: (width: number) => void;
      setPanelOpacity?: (opacity: number) => void;
      copyToClipboard?: (text: string) => Promise<boolean>;
      openBackendFolder?: () => Promise<unknown>;
      captureScreen?: () => Promise<{ ok?: boolean; visible_text_len?: number; reason?: string }>;
      openScreenPrivacySettings?: () => Promise<{ ok: boolean; error?: string }>;
      openAccessibilitySettings?: () => Promise<{ ok: boolean; error?: string }>;
      onboardingDone?: () => Promise<{ ok: boolean }>;
      stripMouseEnter?: () => void;
      stripMouseLeave?: () => void;
      onPanelState?: (handler: (payload: { collapsed: boolean }) => void) => () => void;
    };
  }
}

type TabId = "chat" | "history" | "templates" | "websearch" | "actions" | "settings";

const ChatTab = lazy(() => import("./Chat").then((mod) => ({ default: mod.Chat })));
const HistoryTab = lazy(() => import("./ConversationHistory").then((mod) => ({ default: mod.ConversationHistory })));
const TemplatesTab = lazy(() => import("./TemplateLibrary").then((mod) => ({ default: mod.TemplateLibrary })));
const SettingsTab = lazy(() =>
  import("./SettingsPanelLite").then((mod) => ({
    default: mod.SettingsPanelLite,
  }))
);
const ActionsTab = lazy(() => import("./ActionStudio").then((mod) => ({ default: mod.ActionStudio })));
const WebSearchTab = lazy(() => import("./WebSearchPanel").then((mod) => ({ default: mod.WebSearchPanel })));

interface PanelProps {
  onSignInClick?: (feature?: string) => void;
  initialTab?: TabId;
}

export function Panel({ onSignInClick, initialTab }: PanelProps) {
  const [backendReady, setBackendReady] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>(initialTab ?? "chat");
  const [webSources, setWebSources] = useState<Array<{ title: string; url: string; snippet: string }>>([]);
  const [conversationQuery, setConversationQuery] = useState("");
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [panelWidth, setPanelWidth] = useState(340);
  const [panelOpacity, setPanelOpacity] = useState(0.95);
  const [sidebarPosition, setSidebarPosition] = useState<"left" | "right">("right");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [modeLabel, setModeLabel] = useState("general");
  const [clipboardHint, setClipboardHint] = useState<string | null>(null);
  const [hotkeys, setHotkeys] = useState<HotkeyItem[]>([]);
  const [backendMeta, setBackendMeta] = useState<BackendMeta | null>(null);
  const [lastClipboardText, setLastClipboardText] = useState<string | null>(null);
  const [blockedApps, setBlockedApps] = useState<string[]>([]);
  const [redactSensitive, setRedactSensitive] = useState(true);
  const [meetingFocus, setMeetingFocus] = useState(false);
  const [allowlistOnly, setAllowlistOnly] = useState(false);
  const [allowedAppsCsv, setAllowedAppsCsv] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const [transparencyDump, setTransparencyDump] = useState<string | null>(null);

  // When App passes a new initialTab (from strip icon click), switch to it
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  const buildPrivacyPayload = useCallback(
    (patch: Partial<PrivacySettings> & { blocked_apps?: string[] }): PrivacySettings => {
      const allowed = (patch.allowed_apps ?? allowedAppsCsv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) as string[];
      return {
        blocked_apps: patch.blocked_apps ?? blockedApps,
        redact_sensitive: patch.redact_sensitive ?? redactSensitive,
        meeting_focus: patch.meeting_focus ?? meetingFocus,
        context_allowlist_only: patch.context_allowlist_only ?? allowlistOnly,
        allowed_apps: allowed,
      };
    },
    [allowlistOnly, allowedAppsCsv, blockedApps, meetingFocus, redactSensitive]
  );

  const persistPrivacy = useCallback(
    (patch: Partial<PrivacySettings> & { blocked_apps?: string[] }) => {
      savePrivacySettings(buildPrivacyPayload(patch)).catch(() => {});
    },
    [buildPrivacyPayload]
  );

  useEffect(() => {
    const check = async () => {
      try {
        const ok = await healthCheck();
        setBackendReady(ok);
      } catch {
        setBackendReady(false);
      }
    };
    check();
    const id = setInterval(check, 2000);
    return () => clearInterval(id);
  }, []);

  const { context, suggestions, error: contextError } = useContextPoll(backendReady);

  useEffect(() => {
    if (!backendReady) {
      setBackendMeta(null);
      return;
    }
    const tick = () => {
      fetchBackendMeta()
        .then(setBackendMeta)
        .catch(() => setBackendMeta(null));
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => clearInterval(id);
  }, [backendReady]);

  useEffect(() => {
    const tabs: TabId[] = ["chat", "history", "templates", "websearch", "actions", "settings"];
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const m = e.code.match(/^Digit([1-7])$/);
      if (!m) return;
      e.preventDefault();
      const idx = parseInt(m[1], 10) - 1;
      if (tabs[idx]) setActiveTab(tabs[idx]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onPal = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setCommandOpen((o) => !o);
    };
    window.addEventListener("keydown", onPal, true);
    return () => window.removeEventListener("keydown", onPal, true);
  }, []);

  const commandItems: CommandItem[] = useMemo(
    () => [
      { id: "chat", label: "Go to Chat", run: () => setActiveTab("chat") },
      { id: "history", label: "Go to History", run: () => setActiveTab("history") },
      { id: "templates", label: "Go to Templates", run: () => setActiveTab("templates") },
      { id: "websearch", label: "Go to Web search", run: () => setActiveTab("websearch") },
      { id: "actions", label: "Go to Actions", run: () => setActiveTab("actions") },
      { id: "settings", label: "Go to Settings", run: () => setActiveTab("settings") },
      {
        id: "cap",
        label: "Toggle screen capture pause",
        hint: "Uses backend capture_paused",
        run: async () => {
          if (!backendReady) return;
          try {
            const p = await getCapturePaused();
            await setCapturePaused(!p);
            const meta = await fetchBackendMeta();
            setBackendMeta(meta);
          } catch {
            /* ignore */
          }
        },
      },
      {
        id: "transparency",
        label: "View last chat context summary",
        hint: "Chars sent, app name — no raw screen text",
        run: async () => {
          if (!backendReady) return;
          try {
            const t = await fetchLastChatTransparency();
            setTransparencyDump(JSON.stringify(t, null, 2));
            setActiveTab("settings");
          } catch {
            setTransparencyDump("{}");
          }
        },
      },
    ],
    [backendReady]
  );
  const {
    messages,
    loading,
    error: chatError,
    send,
    clear,
    offlineQueueSize,
    conversationId,
    loadConversationMessages,
    stop,
    retryLast,
    retryQueued,
    dismissOfflineQueue,
    memoryMode,
    setMemoryMode,
    useScreenContext,
    setUseScreenContext,
  } = useChat((context ?? null) as Record<string, unknown> | null, backendReady);
  const appLabel = context?.active_app?.trim() || "No context yet";

  useEffect(() => {
    if (!backendReady || !appLabel || appLabel === "No context yet") return;
    resolveAppMode(appLabel)
      .then((res) => setModeLabel(res.mode.mode || "general"))
      .catch(() => {});
  }, [backendReady, appLabel]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    window.sideai?.setSidebarPosition?.(sidebarPosition);
    window.sideai?.setPanelWidth?.(panelWidth);
    window.sideai?.setPanelOpacity?.(panelOpacity);
  }, [sidebarPosition, panelWidth, panelOpacity]);

  useEffect(() => {
    const unsubHotkey = window.sideai?.onHotkeyTriggered?.((payload) => {
      const templateId = payload?.template_id;
      if (!templateId) return;
      const matched = templates.find((t) => t.id === templateId);
      if (!matched?.prompt) {
        // Template was deleted or not yet loaded — tell the user instead of silent failure
        setClipboardHint("⌨️ Hotkey fired but the linked template was deleted. Go to Library → Actions to reassign it.");
        setTimeout(() => setClipboardHint(null), 6000);
        return;
      }
      setActiveTab("chat");
      send(matched.prompt, (context ?? null) as Record<string, unknown> | null);
    });
    const unsubClipboard = window.sideai?.onClipboardChanged?.((payload) => {
      const content = payload?.content || "";
      if (!content.trim()) return;
      setLastClipboardText(content.slice(0, 2000));
      analyzeClipboard(content)
        .then((r) => {
          setClipboardHint(r.suggestion);
          setTimeout(() => setClipboardHint(null), 8000);
        })
        .catch(() => {});
    });
    return () => {
      if (typeof unsubHotkey === "function") unsubHotkey();
      if (typeof unsubClipboard === "function") unsubClipboard();
    };
  }, [templates, send, context]);

  useEffect(() => {
    if (!backendReady) return;
    fetchConversations({ query: conversationQuery })
      .then((r) => setConversations(r.items || []))
      .catch(() => {});
  }, [backendReady, conversationQuery, messages.length]);

  useEffect(() => {
    if (!backendReady) return;
    fetchTemplates().then((r) => setTemplates(r.items || [])).catch(() => {});
    fetchSettings()
      .then((r) => {
        const settings = r.items || {};
        const width = Number(settings.panel_width?.value ?? 340);
        const opacity = Number(settings.panel_opacity?.value ?? 0.95);
        const nextSidebar = String(settings.sidebar_position?.value ?? "right").toLowerCase() as "left" | "right";
        if (!Number.isNaN(width)) setPanelWidth(width);
        if (!Number.isNaN(opacity)) setPanelOpacity(opacity);
        if (nextSidebar === "left" || nextSidebar === "right") setSidebarPosition(nextSidebar);
        // Respect explicitly saved theme; otherwise keep the dark default
        const saved = String(settings.theme?.value ?? "");
        if (saved === "light" || saved === "dark") {
          setTheme(saved);
        }
      })
      .catch(() => {});
    fetchHotkeys().then((r) => setHotkeys(r.items || [])).catch(() => {});
    getPrivacySettings()
      .then((privacy) => {
        setBlockedApps(privacy.blocked_apps || []);
        setRedactSensitive(Boolean(privacy.redact_sensitive));
        setMeetingFocus(Boolean(privacy.meeting_focus));
        setAllowlistOnly(Boolean(privacy.context_allowlist_only));
        setAllowedAppsCsv((privacy.allowed_apps || []).join(", "));
      })
      .catch(() => {});
  }, [backendReady]);

  const tabButtons = useMemo(
    () =>
      [
        { id: "chat",      label: "Chat",      shortLabel: "Chat"     },
        { id: "history",   label: "History",   shortLabel: "History"  },
        { id: "templates", label: "Templates", shortLabel: "Library"  },
        { id: "websearch", label: "Web search",shortLabel: "Web"      },
        { id: "actions",   label: "Actions",   shortLabel: "Actions"  },
        { id: "settings",  label: "Settings",  shortLabel: "Settings" },
      ] as Array<{ id: TabId; label: string; shortLabel: string }>,
    []
  );

  return (
    <div
      className="h-screen flex flex-col bg-panel-bg border-l border-panel-border text-[color:var(--panel-text)] shadow-panel-lg rounded-l-2xl overflow-hidden motion-safe:transition-surface relative"
      style={{ width: panelWidth, opacity: panelOpacity }}
    >
      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} commands={commandItems} />
      {transparencyDump != null && (
        <div
          className="absolute inset-x-0 bottom-0 z-[150] max-h-[45%] flex flex-col border-t border-panel-border bg-panel-bg-elevated shadow-panel-lg"
          role="dialog"
          aria-label="Last chat transparency"
        >
          <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-panel-border">
            <p className="text-[11px] font-medium text-[color:var(--panel-text)]">Last chat context (summary)</p>
            <button
              type="button"
              className="text-[10px] px-2 py-0.5 rounded border border-panel-border text-panel-muted"
              onClick={() => setTransparencyDump(null)}
            >
              Close
            </button>
          </div>
          <pre className="flex-1 min-h-0 overflow-auto p-2 text-[10px] text-panel-muted whitespace-pre-wrap">{transparencyDump}</pre>
        </div>
      )}

      {/* ── Header ── */}
      <header className="shrink-0 border-b border-panel-border bg-panel-bg-elevated px-3 py-2 flex items-center gap-2.5 shadow-panel">
        {/* Duck logo mark */}
        <div
          className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: "linear-gradient(135deg, color-mix(in srgb, var(--panel-accent) 18%, transparent), color-mix(in srgb, var(--panel-accent-2,#a855f7) 10%, transparent))",
            border: "1px solid color-mix(in srgb, var(--panel-accent) 28%, var(--panel-border))",
          }}
          aria-hidden
        >
          <DuckLogoIcon />
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-[2px] border-panel-bg-elevated ${
              backendReady ? "bg-emerald-500 animate-status" : "bg-amber-400 animate-status-warn"
            }`}
          />
        </div>

        {/* Wordmark + context */}
        <div className="min-w-0 flex-1 flex flex-col gap-0.5">
          <span className="text-sm font-bold tracking-tight whitespace-nowrap gradient-text">DuckAI</span>
          {modeLabel && modeLabel !== "general" && (
            <span
              className="text-[10px] font-medium truncate max-w-[120px] leading-none"
              style={{ color: "var(--panel-muted)" }}
              title={`${appLabel} · ${modeLabel}`}
            >
              {appLabel.length > 16 ? appLabel.slice(0, 14) + "…" : appLabel} · {modeLabel}
            </span>
          )}
        </div>

        {/* Collapse button */}
        <button
          type="button"
          onClick={() => {
            if (typeof window.sideai?.togglePanel === "function") window.sideai.togglePanel();
          }}
          className="focus-ring h-7 w-7 flex items-center justify-center rounded-lg border border-panel-border bg-panel-surface/80 text-panel-muted hover:text-[color:var(--panel-text)] hover:bg-panel-surface-hover hover:border-panel-accent/25 motion-safe:transition-surface shrink-0"
          title="Collapse panel (⌘⇧A)"
          aria-label="Collapse panel"
        >
          <ChevronRightIcon />
        </button>
      </header>

      {/* ── Tab navigation ── */}
      <nav
        className="shrink-0 flex border-b border-panel-border bg-panel-bg-elevated/80"
        aria-label="Primary navigation"
      >
        {tabButtons.map((tab, idx) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => setActiveTab(tab.id)}
              title={`${tab.label} (Alt+${idx + 1})`}
              className="focus-ring flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[42px] motion-safe:transition-surface"
              style={{
                color: isActive ? "var(--panel-accent)" : "var(--panel-muted)",
                borderBottom: isActive ? "2px solid var(--panel-accent)" : "2px solid transparent",
                background: isActive ? "color-mix(in srgb, var(--panel-accent) 5%, transparent)" : "transparent",
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--panel-text)";
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--panel-surface-hover)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--panel-muted)";
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }
              }}
            >
              <TabNavIcon tabId={tab.id} />
              {/* Label fades in only on active tab — preserves consistent button height */}
              <span
                className="text-[9px] font-semibold tracking-wide leading-none transition-opacity duration-150"
                style={{ opacity: isActive ? 1 : 0, height: "10px" }}
              >
                {tab.shortLabel}
              </span>
            </button>
          );
        })}
      </nav>

      {/* ── Context / status bar — only when there's an issue ── */}
      {(!backendReady ||
        Boolean(context?.privacy_blocked) ||
        Boolean(context?.context_limited_reason) ||
        offlineQueueSize > 0) && (
        <ContextTrustBar
          backendReady={backendReady}
          meta={backendMeta}
          privacyBlocked={Boolean(context?.privacy_blocked)}
          offlineQueueSize={offlineQueueSize}
          onOpenBackendFolder={
            typeof window !== "undefined" && typeof window.sideai?.openBackendFolder === "function"
              ? () => { void window.sideai!.openBackendFolder!(); }
              : undefined
          }
          contextReceipt={
            backendReady && context
              ? {
                  active_app: String(context.active_app ?? ""),
                  window_title: String(context.window_title ?? ""),
                  privacy_blocked: Boolean(context.privacy_blocked),
                  context_limited_reason:
                    typeof context.context_limited_reason === "string" ? context.context_limited_reason : null,
                  captured_at: typeof context.captured_at === "number" ? context.captured_at : undefined,
                  visible_text_chars:
                    typeof context.visible_text === "string" ? context.visible_text.length : undefined,
                  ocr_confidence:
                    typeof context.ocr_confidence === "number" ? context.ocr_confidence : undefined,
                  blocked_fields: Boolean(context.privacy_blocked) ? ["visible_text"] : [],
                  redacted_fields: [],
                }
              : null
          }
        />
      )}

      {clipboardHint && (
        <div className="mx-3 mt-2 rounded-xl border border-panel-accent/20 bg-panel-accent/5 px-3 py-2 text-[11px] text-[color:var(--panel-text)] shadow-panel motion-safe:transition-surface space-y-2">
          <p>{clipboardHint}</p>
          {lastClipboardText?.trim() && (
            <button
              type="button"
              className="focus-ring text-[10px] font-semibold rounded-md border border-panel-accent/40 bg-panel-surface px-2 py-1 hover:bg-panel-accent/10 motion-safe:transition-surface"
              onClick={() => {
                setActiveTab("chat");
                setWebSources([]);
                const clip = lastClipboardText.trim();
                send(
                  `I have this on my clipboard. Summarize it and suggest one useful next step:\n\n"""\n${clip}\n"""`,
                  (context ?? null) as Record<string, unknown> | null
                );
                setClipboardHint(null);
              }}
            >
              Ask DuckAI about clipboard
            </button>
          )}
        </div>
      )}

      {activeTab === "chat" && (
        <div className="flex-1 min-h-0 flex flex-col">
          <Suspense fallback={<TabLoading title="Chat" />}>
            <ChatTab
              messages={messages}
              loading={loading}
              offlineQueueSize={offlineQueueSize}
              error={chatError ?? (backendReady ? contextError ?? null : "Connecting to backend…")}
              onClear={() => {
                setWebSources([]);
                clear();
              }}
              appContext={appLabel}
              windowTitle={context?.window_title}
              sources={webSources}
              onQuickAction={(prompt) => {
                setWebSources([]);
                send(prompt, (context ?? null) as Record<string, unknown> | null);
              }}
              onStop={() => {
                stop();
              }}
              onRetry={() => {
                retryLast();
              }}
              onRetryOfflineQueue={() => {
                void retryQueued();
              }}
              onDismissOfflineQueue={dismissOfflineQueue}
              memoryMode={memoryMode}
              onMemoryModeChange={setMemoryMode}
              conversationId={conversationId}
              useScreenContext={useScreenContext}
              onUseScreenContextChange={setUseScreenContext}
            />
          </Suspense>

          {/* ── Context action cards ── */}
          <ContextCards
            context={(context ?? null) as Record<string, unknown> | null}
            backendReady={backendReady}
          />

          {/* ── AI suggestion chips ── */}
          {suggestions.length > 0 && (
            <div className="shrink-0 px-3 pb-1.5 flex gap-1.5 flex-wrap animate-fade-up">
              {suggestions.slice(0, 3).map((s, i) => (
                <button
                  key={`${i}-${s.slice(0, 12)}`}
                  type="button"
                  onClick={() => {
                    setWebSources([]);
                    send(s, (context ?? null) as Record<string, unknown> | null, { onWebHits: setWebSources });
                  }}
                  className="suggestion-chip focus-ring"
                >
                  {s.length > 48 ? s.slice(0, 45) + "…" : s}
                </button>
              ))}
            </div>
          )}

          <InputBar
            onSend={(text) => {
              setWebSources([]);
              send(text, (context ?? null) as Record<string, unknown> | null, {
                onWebHits: setWebSources,
              });
            }}
            disabled={!backendReady || loading}
          />
        </div>
      )}

      {activeTab === "history" && (
        <Suspense fallback={<TabLoading title="History" />}>
          <HistoryTab
            items={conversations}
            query={conversationQuery}
            onQueryChange={setConversationQuery}
            activeConversationId={conversationId}
            onOpen={async (conversationToOpenId) => {
              try {
                const conv = await fetchConversation(conversationToOpenId);
                loadConversationMessages(
                  (conv.messages || []).map((m) => ({
                    role: m.role,
                    content: m.content,
                    id: m.id,
                  })),
                  conv.id
                );
                setActiveTab("chat");
              } catch {
                // ignore
              }
            }}
          />
        </Suspense>
      )}

      {activeTab === "templates" && (
        <Suspense fallback={<TabLoading title="Templates" />}>
          <TemplatesTab
            items={templates}
            onRunTemplate={(prompt) => {
              setActiveTab("chat");
              send(prompt, (context ?? null) as Record<string, unknown> | null);
            }}
            onCreateTemplate={async (name, prompt) => {
              try {
                const created = await createTemplate({ name, prompt });
                setTemplates((prev) => [created, ...prev]);
              } catch {
                // ignore
              }
            }}
            onDeleteTemplate={async (templateId) => {
              try {
                await deleteTemplate(templateId);
                setTemplates((prev) => prev.filter((item) => item.id !== templateId));
              } catch {
                // ignore
              }
            }}
            onImportTemplates={async (items) => {
              try {
                const out = await importTemplates(items);
                setTemplates(out.items || []);
              } catch {
                // ignore
              }
            }}
          />
        </Suspense>
      )}

      {activeTab === "settings" && (
        <Suspense fallback={<TabLoading title="Settings" />}>
          <SettingsTab
            backendReady={backendReady}
            onSignInClick={onSignInClick}
            panelWidth={panelWidth}
            panelOpacity={panelOpacity}
            sidebarPosition={sidebarPosition}
            theme={theme}
            templates={templates}
            hotkeys={hotkeys}
            onPanelWidthChange={(value) => {
              setPanelWidth(value);
              window.sideai?.setPanelWidth?.(value);
              patchSetting("panel_width", String(value), "number").catch(() => {});
            }}
            onPanelOpacityChange={(value) => {
              setPanelOpacity(value);
              window.sideai?.setPanelOpacity?.(value);
              patchSetting("panel_opacity", String(value), "number").catch(() => {});
            }}
            onSidebarPositionChange={(value) => {
              setSidebarPosition(value);
              window.sideai?.setSidebarPosition?.(value);
              patchSetting("sidebar_position", value).catch(() => {});
            }}
            onThemeChange={(value) => {
              setTheme(value);
              patchSetting("theme", value).catch(() => {});
            }}
            onCreateHotkey={async (keyCombo, templateId) => {
              const created = await createHotkey({ key_combo: keyCombo, template_id: templateId, enabled: true });
              setHotkeys((prev) => [created, ...prev]);
            }}
            onDeleteHotkey={async (hotkeyId) => {
              await deleteHotkey(hotkeyId);
              setHotkeys((prev) => prev.filter((h) => h.id !== hotkeyId));
            }}
            blockedApps={blockedApps}
            redactSensitive={redactSensitive}
            onBlockedAppsChange={(apps) => {
              setBlockedApps(apps);
              persistPrivacy({ blocked_apps: apps });
            }}
            onRedactSensitiveChange={(value) => {
              setRedactSensitive(value);
              persistPrivacy({ redact_sensitive: value });
            }}
            meetingFocus={meetingFocus}
            allowlistOnly={allowlistOnly}
            allowedAppsCsv={allowedAppsCsv}
            onMeetingFocusChange={(value) => {
              setMeetingFocus(value);
              persistPrivacy({ meeting_focus: value });
            }}
            onAllowlistOnlyChange={(value) => {
              setAllowlistOnly(value);
              persistPrivacy({ context_allowlist_only: value });
            }}
            onAllowedAppsCsvChange={setAllowedAppsCsv}
            onAllowedAppsBlur={() => persistPrivacy({})}
            onOpenLastChatTransparency={() => {
              void fetchLastChatTransparency()
                .then((t) => setTransparencyDump(JSON.stringify(t, null, 2)))
                .catch(() => setTransparencyDump("{}"));
            }}
          />
        </Suspense>
      )}

      {activeTab === "actions" && (
        <Suspense fallback={<TabLoading title="Actions" />}>
          <ActionsTab
            onUseText={(text, sources) => {
              setWebSources(sources || []);
              setActiveTab("chat");
              send(text, (context ?? null) as Record<string, unknown> | null);
            }}
          />
        </Suspense>
      )}

      {activeTab === "websearch" && (
        <Suspense fallback={<TabLoading title="Web search" />}>
          <WebSearchTab
            context={(context ?? null) as Record<string, unknown> | null}
            onUseOutput={(text, sources) => {
              setWebSources(sources || []);
              setActiveTab("chat");
              send(text, (context ?? null) as Record<string, unknown> | null);
            }}
          />
        </Suspense>
      )}


    </div>
  );
}

// ── Context action cards (Summarize / Email draft) ───────────────────────────
function ContextCards({
  context,
  backendReady,
}: {
  context: Record<string, unknown> | null | undefined;
  backendReady: boolean;
}) {
  const [openCard, setOpenCard] = useState<"summarize" | "email" | null>(null);

  if (!backendReady || !context) return null;

  const app = String(context.active_app ?? "");
  const title = String(context.window_title ?? "");
  const visibleText = String(context.visible_text ?? "");

  const isBrowser = isBrowserContext(app, title);
  const isEmail = isEmailContext(app, title, "", visibleText);

  if (!isBrowser && !isEmail) return null;

  return (
    <div className="shrink-0 border-t border-panel-border/60">
      {/* Card selector tabs */}
      <div className="flex gap-1 px-3 pt-2">
        {isBrowser && (
          <button
            type="button"
            onClick={() => setOpenCard(openCard === "summarize" ? null : "summarize")}
            className="flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1.5 rounded-lg transition-all"
            style={{
              background: openCard === "summarize"
                ? "color-mix(in srgb, var(--panel-accent) 12%, transparent)"
                : "var(--panel-surface)",
              color: openCard === "summarize" ? "var(--panel-accent)" : "var(--panel-muted)",
              border: openCard === "summarize"
                ? "1px solid color-mix(in srgb, var(--panel-accent) 25%, transparent)"
                : "1px solid var(--panel-border)",
            }}
          >
            <PageSumIcon />
            Summarize
          </button>
        )}
        {isEmail && (
          <button
            type="button"
            onClick={() => setOpenCard(openCard === "email" ? null : "email")}
            className="flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1.5 rounded-lg transition-all"
            style={{
              background: openCard === "email"
                ? "color-mix(in srgb, var(--panel-accent) 12%, transparent)"
                : "var(--panel-surface)",
              color: openCard === "email" ? "var(--panel-accent)" : "var(--panel-muted)",
              border: openCard === "email"
                ? "1px solid color-mix(in srgb, var(--panel-accent) 25%, transparent)"
                : "1px solid var(--panel-border)",
            }}
          >
            <MailDraftIcon />
            Draft reply
          </button>
        )}
      </div>

      {/* Expanded card */}
      {openCard === "summarize" && (
        <div className="px-3 pb-3 pt-2">
          <SummarizePanel
            screenText={String(context.visible_text ?? "")}
            windowTitle={String(context.window_title ?? "")}
            activeApp={String(context.active_app ?? "")}
          />
        </div>
      )}
      {openCard === "email" && (
        <div className="px-3 pb-3 pt-2">
          <EmailDraftPanel
            screenText={String(context.visible_text ?? "")}
            windowTitle={String(context.window_title ?? "")}
            activeApp={String(context.active_app ?? "")}
          />
        </div>
      )}
    </div>
  );
}

function PageSumIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M4.5 2A1.5 1.5 0 0 0 3 3.5v13A1.5 1.5 0 0 0 4.5 18h11a1.5 1.5 0 0 0 1.5-1.5V7.621a1.5 1.5 0 0 0-.44-1.06l-4.12-4.122A1.5 1.5 0 0 0 11.378 2H4.5Zm2.25 8.5a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5h1.5Zm0-3a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5h1.5Zm6 3a.75.75 0 0 1 0 1.5h-6a.75.75 0 0 1 0-1.5h6Zm0-3a.75.75 0 0 1 0 1.5h-6a.75.75 0 0 1 0-1.5h6Z" clipRule="evenodd" />
    </svg>
  );
}

function MailDraftIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M3 4a2 2 0 0 0-2 2v1.161l8.441 4.221a1.25 1.25 0 0 0 1.118 0L19 7.162V6a2 2 0 0 0-2-2H3Z" />
      <path d="m19 8.839-7.77 3.885a2.75 2.75 0 0 1-2.46 0L1 8.839V14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.839Z" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden>
      <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
    </svg>
  );
}

function DuckLogoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <ellipse cx="9" cy="7.5" rx="4" ry="3.5" fill="var(--panel-accent)" />
      <ellipse cx="5.5" cy="8.5" rx="2.5" ry="2" fill="var(--panel-accent)" opacity="0.8" />
      <circle cx="10.5" cy="6" r="1" fill="var(--panel-bg-elevated)" />
      <path d="M3.5 9.5 L1.5 10 L3.5 10.5 Z" fill="var(--panel-accent)" opacity="0.9" />
    </svg>
  );
}

function TabNavIcon({ tabId }: { tabId: string }) {
  const cls = "w-4 h-4";
  switch (tabId) {
    case "chat":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={cls} aria-hidden>
          <path fillRule="evenodd" d="M10 2c-2.236 0-4.43.18-6.57.524C1.993 2.755 1 4.014 1 5.426v5.148c0 1.413.993 2.67 2.43 2.902.848.137 1.705.248 2.57.331v3.443a.75.75 0 0 0 1.28.53l3.658-3.658A18.597 18.597 0 0 0 10 14c2.236 0 4.43-.18 6.57-.524 1.437-.231 2.43-1.49 2.43-2.902V5.426c0-1.413-.993-2.67-2.43-2.902A41.102 41.102 0 0 0 10 2Z" clipRule="evenodd" />
        </svg>
      );
    case "history":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={cls} aria-hidden>
          <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z" clipRule="evenodd" />
        </svg>
      );
    case "templates":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={cls} aria-hidden>
          <path fillRule="evenodd" d="M4 4a2 2 0 0 1 2-2h4.586A2 2 0 0 1 12 2.586L15.414 6A2 2 0 0 1 16 7.414V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4Zm2 6a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H7a1 1 0 0 1-1-1Zm1 3a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2H7Z" clipRule="evenodd" />
        </svg>
      );
    case "websearch":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={cls} aria-hidden>
          <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
        </svg>
      );
    case "actions":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={cls} aria-hidden>
          <path fillRule="evenodd" d="M13.18 3.59A1.25 1.25 0 0 1 14.36 5.5l-1.83 5.25h4.22a1.25 1.25 0 0 1 .91 2.104l-8.75 9.375a1.25 1.25 0 0 1-2.12-1.178l1.832-5.25H4.42a1.25 1.25 0 0 1-.91-2.105l8.75-9.375a1.25 1.25 0 0 1 .92-.52Z" clipRule="evenodd" />
        </svg>
      );
    case "settings":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={cls} aria-hidden>
          <path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
        </svg>
      );
    default:
      return null;
  }
}
