interface AvatarProps {
  online: boolean;
  collapsed?: boolean;
}

export function Avatar({ online, collapsed }: AvatarProps) {
  return (
    <div
      className="flex items-center gap-3 shrink-0"
      aria-label={online ? "DuckAI online" : "DuckAI offline"}
    >
      <div
        className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-panel-accent to-violet-700 border border-panel-border shadow-glow"
        aria-hidden
      >
        <span className="text-sm font-bold text-[color:var(--accent-text)]" aria-hidden>
          AI
        </span>
        {online && (
          <span
            className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-panel-bg"
            aria-hidden
          />
        )}
      </div>
      {!collapsed && (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[color:var(--panel-text)] truncate">DuckAI</p>
          <p className="text-xs text-panel-muted">
            {online ? "Online" : "Connecting…"}
          </p>
        </div>
      )}
    </div>
  );
}
