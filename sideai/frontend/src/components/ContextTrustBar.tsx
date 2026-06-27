import { useState } from "react";
import type { BackendMeta } from "../hooks/useBackend";

const BACKEND_RECOVERY_TIPS = `DuckAI Python API (http://127.0.0.1:8000)

• From a terminal:
  cd sideai/backend && source venv/bin/activate && uvicorn main:app --host 127.0.0.1 --port 8000

• Electron: ensure sideai/backend/venv exists and port 8000 is free.

• Web dev (Vite): panel expects the API at 127.0.0.1:8000 — start the backend before the UI.
`;

export interface ContextReceiptInfo {
  active_app?: string;
  window_title?: string;
  privacy_blocked?: boolean;
  /** blocklist | meeting_focus | allowlist — screen text withheld */
  context_limited_reason?: string | null;
  captured_at?: number;
  /** Length of captured on-screen text sent to the model (characters). Content itself is not shown here. */
  visible_text_chars?: number;
  ocr_confidence?: number;
  blocked_fields?: string[];
  redacted_fields?: string[];
}

interface ContextTrustBarProps {
  meta: BackendMeta | null;
  privacyBlocked?: boolean;
  offlineQueueSize?: number;
  backendReady: boolean;
  /** Opens backend folder in Finder/Explorer (Electron). */
  onOpenBackendFolder?: () => void | Promise<void>;
  contextReceipt?: ContextReceiptInfo | null;
}

function formatStale(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function formatCapturedAt(ts: number | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return "—";
  const d = new Date(Math.floor(ts) * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ContextTrustBar({
  meta,
  privacyBlocked,
  offlineQueueSize = 0,
  backendReady,
  onOpenBackendFolder,
  contextReceipt,
}: ContextTrustBarProps) {
  const [receiptOpen, setReceiptOpen] = useState(false);

  if (!backendReady) {
    return (
      <div
        className="shrink-0 px-3 py-2 border-b border-panel-border bg-amber-500/10 text-[10px] text-[color:var(--semantic-warn-text)] space-y-2"
        role="status"
      >
        <p className="font-semibold text-[color:var(--panel-text)]">Can’t reach the Python API</p>
        <p className="text-panel-muted leading-snug">
          Expected at <code className="text-[10px] bg-panel-bg/80 px-1 rounded">http://127.0.0.1:8000</code>. The panel will
          reconnect automatically when the backend is up.
        </p>
        <ul className="list-disc pl-4 text-panel-muted space-y-0.5 leading-snug">
          <li>Start uvicorn from <code className="text-[9px]">sideai/backend</code> (see README).</li>
          <li>Confirm nothing else is using port 8000.</li>
        </ul>
        <div className="flex flex-wrap gap-2 pt-0.5">
          <button
            type="button"
            className="focus-ring rounded-md border border-amber-600/40 bg-panel-bg/60 px-2 py-1 text-[10px] font-medium text-[color:var(--panel-text)] hover:bg-panel-bg motion-safe:transition-surface"
            onClick={() => navigator.clipboard.writeText(BACKEND_RECOVERY_TIPS).catch(() => {})}
          >
            Copy recovery tips
          </button>
          {typeof onOpenBackendFolder === "function" && (
            <button
              type="button"
              className="focus-ring rounded-md border border-panel-border bg-panel-bg/60 px-2 py-1 text-[10px] font-medium text-[color:var(--panel-text)] hover:bg-panel-surface motion-safe:transition-surface"
              onClick={() => {
                void onOpenBackendFolder();
              }}
            >
              Open backend folder
            </button>
          )}
        </div>
      </div>
    );
  }

  const paused = meta?.capture_paused ?? false;
  const stale = meta?.context_stale_seconds;
  const titleShort =
    contextReceipt?.window_title && contextReceipt.window_title.length > 72
      ? `${contextReceipt.window_title.slice(0, 72)}…`
      : contextReceipt?.window_title;

  return (
    <div
      className="shrink-0 px-3 py-1.5 border-b border-panel-border bg-panel-bg/80 flex flex-col gap-1 text-[10px]"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className={paused ? "text-amber-600 font-medium" : "text-emerald-600 font-medium"}>
          {paused ? "● Capture paused" : "● Capture live"}
        </span>
        <span className="text-panel-muted">
          Last context: <span className="text-[color:var(--panel-text)]">{formatStale(stale ?? null)}</span>
        </span>
        {privacyBlocked && (
          <span className="text-panel-accent font-medium" title="This app is on your privacy blocklist">
            Privacy block active
          </span>
        )}
        {contextReceipt?.context_limited_reason && (
          <span className="text-amber-600 font-medium" title="Visible text withheld by privacy settings">
            Text withheld ({contextReceipt.context_limited_reason})
          </span>
        )}
        {!contextReceipt?.context_limited_reason &&
          typeof contextReceipt?.visible_text_chars === "number" &&
          contextReceipt.visible_text_chars < 20 &&
          !privacyBlocked && (
            <span className="text-amber-600 font-medium" title="Capture is active but OCR found little text">
              Low screen text — collapse panel to refresh
            </span>
          )}
        {offlineQueueSize > 0 && (
          <span className="text-amber-600 font-medium">{offlineQueueSize} message(s) queued offline</span>
        )}
      </div>
      {contextReceipt && (
        <div className="border-t border-panel-border/60 pt-1 mt-0.5">
          <button
            type="button"
            className="focus-ring text-[10px] font-medium text-panel-muted hover:text-[color:var(--panel-text)]"
            aria-expanded={receiptOpen}
            onClick={() => setReceiptOpen((o) => !o)}
          >
            Context receipt {receiptOpen ? "▾" : "▸"}
          </button>
          {receiptOpen && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-panel-muted">
              <dt className="font-medium text-[color:var(--panel-text)]">App</dt>
              <dd className="truncate" title={contextReceipt.active_app}>
                {contextReceipt.active_app?.trim() || "—"}
              </dd>
              <dt className="font-medium text-[color:var(--panel-text)]">Window</dt>
              <dd className="truncate" title={contextReceipt.window_title}>
                {titleShort?.trim() || "—"}
              </dd>
              <dt className="font-medium text-[color:var(--panel-text)]">Captured</dt>
              <dd>{formatCapturedAt(contextReceipt.captured_at)}</dd>
              <dt className="font-medium text-[color:var(--panel-text)]">Privacy</dt>
              <dd>
                {contextReceipt.privacy_blocked
                  ? "Blocked (blocklist)"
                  : contextReceipt.context_limited_reason
                    ? `Limited: ${contextReceipt.context_limited_reason}`
                    : "OK"}
              </dd>
              {typeof contextReceipt.visible_text_chars === "number" && (
                <>
                  <dt className="font-medium text-[color:var(--panel-text)]">Screen text</dt>
                  <dd title="Character count of captured visible text (not shown for privacy)">
                    {contextReceipt.visible_text_chars.toLocaleString()} chars in context
                  </dd>
                </>
              )}
              {typeof contextReceipt.ocr_confidence === "number" && (
                <>
                  <dt className="font-medium text-[color:var(--panel-text)]">OCR conf</dt>
                  <dd>{Math.round(contextReceipt.ocr_confidence * 100)}%</dd>
                </>
              )}
              <dt className="font-medium text-[color:var(--panel-text)]">Blocked</dt>
              <dd>{contextReceipt.blocked_fields?.join(", ") || "none"}</dd>
              <dt className="font-medium text-[color:var(--panel-text)]">Redacted</dt>
              <dd>{contextReceipt.redacted_fields?.join(", ") || "none"}</dd>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
