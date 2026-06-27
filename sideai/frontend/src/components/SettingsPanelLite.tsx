import { useEffect, useState } from "react";
import { fetchPermissionHealth, fetchPlan, setPlan, type HotkeyItem, type PermissionHealth, type PlanId, type PlanInfo, type TemplateItem } from "../hooks/useBackend";
import { UserMenu } from "./UserMenu";
import { MemoryPanel } from "./MemoryPanel";
import { CalendarPanel } from "./CalendarPanel";
import { NotionConfig } from "./NotionConfig";

const API = "http://127.0.0.1:8000";

interface SettingsPanelLiteProps {
  backendReady: boolean;
  onSignInClick?: () => void;
  panelWidth: number;
  panelOpacity: number;
  sidebarPosition: "left" | "right";
  theme: "dark" | "light";
  templates: TemplateItem[];
  hotkeys: HotkeyItem[];
  blockedApps: string[];
  redactSensitive: boolean;
  meetingFocus: boolean;
  allowlistOnly: boolean;
  allowedAppsCsv: string;
  onMeetingFocusChange: (value: boolean) => void;
  onAllowlistOnlyChange: (value: boolean) => void;
  onAllowedAppsCsvChange: (value: string) => void;
  onAllowedAppsBlur?: () => void;
  onOpenLastChatTransparency?: () => void;
  onPanelWidthChange: (value: number) => void;
  onPanelOpacityChange: (value: number) => void;
  onSidebarPositionChange: (value: "left" | "right") => void;
  onThemeChange: (value: "dark" | "light") => void;
  onCreateHotkey: (keyCombo: string, templateId: string) => Promise<void>;
  onDeleteHotkey: (hotkeyId: string) => Promise<void>;
  onBlockedAppsChange: (apps: string[]) => void;
  onRedactSensitiveChange: (value: boolean) => void;
}

export function SettingsPanelLite({
  backendReady,
  onSignInClick,
  panelWidth,
  panelOpacity,
  sidebarPosition,
  theme,
  templates,
  hotkeys,
  blockedApps,
  redactSensitive,
  meetingFocus,
  allowlistOnly,
  allowedAppsCsv,
  onMeetingFocusChange,
  onAllowlistOnlyChange,
  onAllowedAppsCsvChange,
  onAllowedAppsBlur,
  onOpenLastChatTransparency,
  onPanelWidthChange,
  onPanelOpacityChange,
  onSidebarPositionChange,
  onThemeChange,
  onCreateHotkey,
  onDeleteHotkey,
  onBlockedAppsChange,
  onRedactSensitiveChange,
}: SettingsPanelLiteProps) {
  const [keyCombo, setKeyCombo] = useState("cmd+shift+1");
  const [templateId, setTemplateId] = useState("");
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [permHealth, setPermHealth] = useState<PermissionHealth | null>(null);
  const [permError, setPermError] = useState<string | null>(null);
  const [browserHistoryEnabled, setBrowserHistoryEnabled] = useState(false);
  const [browserHistoryError, setBrowserHistoryError] = useState<string | null>(null);
  const [defaultMemoryMode, setDefaultMemoryMode] = useState("this_chat_only");
  const [planInfo, setPlanInfo] = useState<PlanInfo | null>(null);
  const [planChanging, setPlanChanging] = useState(false);

  useEffect(() => {
    if (!backendReady) return;
    setBrowserHistoryError(null);
    fetch(`${API}/api/browser/status`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((d: { enabled: boolean }) => setBrowserHistoryEnabled(d.enabled))
      .catch(() => setBrowserHistoryError("Could not load browser history status"));
    fetch(`${API}/api/settings/default_memory_mode`).then(r => r.json()).then((d: { value?: string }) => {
      if (d.value) setDefaultMemoryMode(d.value);
    }).catch(() => {});
    fetchPlan().then(setPlanInfo).catch(() => {});
  }, [backendReady]);

  async function saveDefaultMemoryMode(mode: string) {
    setDefaultMemoryMode(mode);
    await fetch(`${API}/api/settings/default_memory_mode`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: mode }),
    }).catch(() => {});
  }

  async function toggleBrowserHistory(enabled: boolean) {
    setBrowserHistoryError(null);
    setBrowserHistoryEnabled(enabled);
    try {
      const r = await fetch(`${API}/api/browser/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      const d = await r.json() as { enabled: boolean };
      setBrowserHistoryEnabled(d.enabled);
    } catch {
      setBrowserHistoryEnabled(!enabled);
      setBrowserHistoryError("Failed to save browser history setting");
    }
  }

  useEffect(() => {
    if (!backendReady) {
      setPermHealth(null);
      setPermError(null);
      return;
    }
    fetchPermissionHealth()
      .then((p) => {
        setPermHealth(p);
        setPermError(null);
      })
      .catch((e) => {
        setPermHealth(null);
        setPermError(e instanceof Error ? e.message : "Could not load permission status");
      });
  }, [backendReady]);

  return (
    <section className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
      {/* Account / auth section — always shown first */}
      <UserMenu onSignInClick={onSignInClick ?? (() => {})} />

      <div className="card p-3">
        <p className="section-title">Panel width: {panelWidth}px</p>
        <input
          type="range"
          min={280}
          max={600}
          value={panelWidth}
          onChange={(e) => onPanelWidthChange(Number(e.target.value))}
          className="w-full mt-2"
        />
      </div>
      <div className="card p-3">
        <p className="section-title">Panel opacity: {panelOpacity.toFixed(2)}</p>
        <input
          type="range"
          min={50}
          max={100}
          value={Math.round(panelOpacity * 100)}
          onChange={(e) => onPanelOpacityChange(Number(e.target.value) / 100)}
          className="w-full mt-2"
        />
      </div>
      <div className="card p-3 space-y-2">
        <p className="section-title">Sidebar position</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onSidebarPositionChange("left")}
            className={`text-xs px-2 py-1 rounded border ${sidebarPosition === "left" ? "border-panel-accent text-[color:var(--panel-accent)] bg-[color:color-mix(in_srgb,var(--panel-accent)_10%,transparent)]" : "border-panel-border text-[color:var(--panel-muted)]"}`}
          >
            Left
          </button>
          <button
            type="button"
            onClick={() => onSidebarPositionChange("right")}
            className={`text-xs px-2 py-1 rounded border ${sidebarPosition === "right" ? "border-panel-accent text-[color:var(--panel-accent)] bg-[color:color-mix(in_srgb,var(--panel-accent)_10%,transparent)]" : "border-panel-border text-[color:var(--panel-muted)]"}`}
          >
            Right
          </button>
        </div>
      </div>
      <div className="card p-3 space-y-2">
        <p className="section-title">Theme</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onThemeChange("dark")}
            className={`text-xs px-2 py-1 rounded border ${theme === "dark" ? "border-panel-accent text-[color:var(--panel-accent)] bg-[color:color-mix(in_srgb,var(--panel-accent)_10%,transparent)]" : "border-panel-border text-[color:var(--panel-muted)]"}`}
          >
            Dark
          </button>
          <button
            type="button"
            onClick={() => onThemeChange("light")}
            className={`text-xs px-2 py-1 rounded border ${theme === "light" ? "border-panel-accent text-[color:var(--panel-accent)] bg-[color:color-mix(in_srgb,var(--panel-accent)_10%,transparent)]" : "border-panel-border text-[color:var(--panel-muted)]"}`}
          >
            Light
          </button>
        </div>
      </div>
      <div className="card p-3 space-y-2">
        <p className="section-title">Default memory mode</p>
        <p className="text-[10px] text-panel-muted leading-snug">
          How new conversations remember context. You can override per-chat.
        </p>
        <div className="flex gap-2 flex-wrap">
          {[
            { id: "this_chat_only", label: "This chat only" },
            { id: "remember_24h",   label: "Remember 24 h" },
            { id: "never_remember", label: "Never remember" },
          ].map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => void saveDefaultMemoryMode(id)}
              className={`text-xs px-2 py-1 rounded border ${defaultMemoryMode === id ? "border-panel-accent text-[color:var(--panel-accent)] bg-[color:color-mix(in_srgb,var(--panel-accent)_10%,transparent)]" : "border-panel-border text-[color:var(--panel-muted)]"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card p-3 space-y-2">
        <p className="section-title">Privacy</p>
        <p className="text-[10px] text-panel-muted leading-snug">
          Blocklist and redaction are saved locally with your DuckAI data and survive backend restarts.
        </p>
        <label className="flex items-center justify-between gap-2 text-xs">
          <span>Redact sensitive text</span>
          <input
            type="checkbox"
            checked={redactSensitive}
            onChange={(e) => onRedactSensitiveChange(e.target.checked)}
          />
        </label>
        <label className="text-[11px] text-panel-muted">Blocked apps (comma-separated)</label>
        <input
          value={blockedApps.join(", ")}
          onChange={(e) =>
            onBlockedAppsChange(
              e.target.value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            )
          }
          placeholder="bank app, password manager"
          className="studio-input w-full"
        />
        <label className="flex items-center justify-between gap-2 text-xs">
          <span>Meeting focus (hide OCR in Zoom, Teams, Meet, …)</span>
          <input type="checkbox" checked={meetingFocus} onChange={(e) => onMeetingFocusChange(e.target.checked)} />
        </label>
        <label className="flex items-center justify-between gap-2 text-xs">
          <span>Allowlist only (only these apps send screen text)</span>
          <input type="checkbox" checked={allowlistOnly} onChange={(e) => onAllowlistOnlyChange(e.target.checked)} />
        </label>
        <label className="text-[11px] text-panel-muted">Allowed apps (substring match, comma-separated)</label>
        <input
          value={allowedAppsCsv}
          onChange={(e) => onAllowedAppsCsvChange(e.target.value)}
          onBlur={() => onAllowedAppsBlur?.()}
          placeholder="chrome, cursor, code"
          className="studio-input w-full"
        />
        {onOpenLastChatTransparency ? (
          <button
            type="button"
            onClick={() => onOpenLastChatTransparency()}
            className="text-xs rounded-md border border-panel-border px-2 py-1 text-panel-muted hover:text-[color:var(--panel-text)] w-full"
          >
            Show last chat context summary (on-device)
          </button>
        ) : null}
      </div>

      <div className="card p-3 space-y-2">
        <p className="section-title">macOS permissions</p>
        {!backendReady && (
          <p className="text-[10px] text-panel-muted leading-snug">Connect to the backend to load permission hints.</p>
        )}
        {backendReady && permError && <p className="text-[11px] text-red-400">{permError}</p>}
        {backendReady && permHealth && (
          <div className="space-y-2 text-[11px] text-panel-muted leading-snug">
            <div>
              <p className="font-medium text-[color:var(--panel-text)]">
                Screen Recording{" "}
                <span className={permHealth.screen_recording.ok ? "text-emerald-500" : "text-amber-500"}>
                  {permHealth.screen_recording.ok ? "· OK" : "· check"}
                </span>
              </p>
              <p>{permHealth.screen_recording.hint}</p>
            </div>
            <div>
              <p className="font-medium text-[color:var(--panel-text)]">
                Accessibility{" "}
                <span className={permHealth.accessibility.ok ? "text-emerald-500" : "text-amber-500"}>
                  {permHealth.accessibility.ok ? "· OK" : "· check"}
                </span>
              </p>
              <p>{permHealth.accessibility.hint}</p>
            </div>
          </div>
        )}
      </div>

      {/* Memory Layer */}
      <div className="card p-3 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">🧠</span>
          <p className="text-xs font-semibold">Memory</p>
        </div>
        <MemoryPanel />
      </div>

      {/* Calendar */}
      <div className="card p-3 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">📅</span>
          <p className="text-xs font-semibold">Google Calendar</p>
        </div>
        <CalendarPanel />
      </div>

      {/* Notion */}
      <div className="card p-3 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">📝</span>
          <p className="text-xs font-semibold">Notion Sync</p>
        </div>
        <NotionConfig />
      </div>

      {/* Browser History Context */}
      <div className="card p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm">🌐</span>
            <p className="text-xs font-semibold">Browser History Context</p>
          </div>
          <input
            type="checkbox"
            checked={browserHistoryEnabled}
            onChange={(e) => void toggleBrowserHistory(e.target.checked)}
            className="accent-indigo-500"
          />
        </div>
        <p className="text-[10px] text-panel-muted leading-snug">
          When enabled, recent tabs from Chrome, Firefox, and Safari are attached to your AI context for smarter suggestions. Reads local history files — no data leaves your device.
        </p>
        {browserHistoryError && (
          <p className="text-[11px] text-red-400">{browserHistoryError}</p>
        )}
      </div>

      {/* Plan */}
      <div className="card p-3 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">⚡</span>
          <p className="text-xs font-semibold">AI Plan</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(["free", "premium", "ultra"] as PlanId[]).map((p) => {
            const labels: Record<PlanId, { name: string; model: string; price: string }> = {
              free:    { name: "Free",    model: "Llama-4-Scout (HF)",   price: "$0/mo" },
              premium: { name: "Premium", model: "Claude Haiku 4.5",      price: "$19/mo" },
              ultra:   { name: "Ultra",   model: "Claude Sonnet 4.6",     price: "$49/mo" },
            };
            const active = planInfo?.plan === p;
            return (
              <button
                key={p}
                type="button"
                disabled={planChanging}
                onClick={async () => {
                  setPlanChanging(true);
                  try {
                    const updated = await setPlan(p);
                    setPlanInfo(updated);
                  } catch { /* ignore */ }
                  setPlanChanging(false);
                }}
                className={`rounded-lg border px-2 py-2 text-left space-y-0.5 transition-colors ${
                  active
                    ? "border-panel-accent bg-panel-accent/15 ring-1 ring-panel-accent/40"
                    : "border-panel-border bg-panel-surface hover:border-panel-accent/40"
                }`}
              >
                <p className={`text-[11px] font-bold ${active ? "text-[color:var(--panel-accent)]" : "text-slate-200"}`}>
                  {labels[p].name}
                </p>
                <p className="text-[9px] text-panel-muted leading-tight">{labels[p].model}</p>
                <p className={`text-[10px] font-semibold ${active ? "text-emerald-400" : "text-panel-muted"}`}>
                  {labels[p].price}
                </p>
              </button>
            );
          })}
        </div>
        {planInfo && (
          <p className="text-[10px] text-panel-muted">
            Active: <span className="text-slate-300 font-medium">{planInfo.name}</span> — {planInfo.model}
            {planInfo.plan !== "free" && (
              <span className="ml-1 text-amber-400/80">(add ANTHROPIC_API_KEY to backend/.env to activate)</span>
            )}
          </p>
        )}
      </div>

      <div className="card p-3 space-y-2">
        <p className="section-title">Template Hotkeys</p>
        <input
          value={keyCombo}
          onChange={(e) => setKeyCombo(e.target.value)}
          placeholder="cmd+shift+1"
          className="studio-input w-full"
        />
        <select
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          className="studio-input w-full"
        >
          <option value="">Select template</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={async () => {
            setHotkeyError(null);
            try {
              if (!keyCombo.trim() || !templateId) return;
              await onCreateHotkey(keyCombo.trim(), templateId);
            } catch (e) {
              setHotkeyError(e instanceof Error ? e.message : "Failed to create hotkey");
            }
          }}
          className="text-xs rounded-md border border-panel-border px-2 py-1 text-panel-muted hover:text-slate-200"
        >
          Add Hotkey
        </button>
        {hotkeyError && <p className="text-[11px] text-red-300">{hotkeyError}</p>}
        <div className="space-y-1">
          {hotkeys.map((h) => (
            <div key={h.id} className="flex items-center justify-between rounded border border-panel-border px-2 py-1">
              <span className="text-[11px] text-slate-200">{h.key_combo} → {h.template_name || h.template_id}</span>
              <button
                type="button"
                onClick={() => onDeleteHotkey(h.id)}
                className="text-[10px] text-panel-muted hover:text-slate-200"
              >
                Delete
              </button>
            </div>
          ))}
          {hotkeys.length === 0 && <p className="text-[11px] text-panel-muted">No hotkeys configured.</p>}
        </div>
      </div>
    </section>
  );
}
