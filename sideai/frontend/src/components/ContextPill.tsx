import type { ScreenContext } from "../hooks/useContext";

interface ContextPillProps {
  context: ScreenContext | null;
  collapsed?: boolean;
}

export function ContextPill({ context, collapsed }: ContextPillProps) {
  if (collapsed || !context) return null;
  const app = context.active_app?.trim() || "Unknown";
  const title = context.window_title?.trim();
  const label = title ? `${app} · ${title}` : app;
  const display = label.length > 42 ? label.slice(0, 41) + "…" : label;
  const confidence = typeof context.ocr_confidence === "number" ? Math.round(context.ocr_confidence * 100) : null;

  return (
    <div
      className="shrink-0 px-3 py-2 border-b border-panel-border bg-panel-bg-elevated"
      aria-label="What I see"
    >
      <p className="text-[10px] uppercase tracking-wider text-panel-muted font-medium mb-1">
        What I see
      </p>
      <p
        className="text-xs text-slate-300 truncate"
        title={label}
      >
        {display || "—"}
      </p>
      <div className="mt-1 flex items-center gap-2">
        {confidence !== null && (
          <span className={`text-[10px] ${confidence >= 65 ? "text-emerald-400" : confidence >= 40 ? "text-amber-400" : "text-rose-400"}`}>
            OCR {confidence}%
          </span>
        )}
        {context.privacy_blocked && (
          <span className="text-[10px] text-amber-400">Capture blocked for this app</span>
        )}
      </div>
    </div>
  );
}
