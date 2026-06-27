import type { QuickAction } from "../hooks/useQuickActions";

interface QuickActionsProps {
  actions: QuickAction[];
  onAction: (prompt: string) => void;
  collapsed?: boolean;
}

export function QuickActions({ actions, onAction, collapsed }: QuickActionsProps) {
  if (collapsed) return null;

  return (
    <section
      className="shrink-0 border-b border-panel-border bg-panel-bg-elevated/50"
      aria-label="Quick actions"
    >
      <h3 className="text-[10px] font-medium text-panel-muted uppercase tracking-wider px-3 pt-2.5 pb-1.5">
        Quick actions
      </h3>
      <div className="flex flex-wrap gap-2 px-2 pb-2.5">
        {actions.map(({ label, prompt }) => (
          <button
            key={label}
            type="button"
            onClick={() => onAction(prompt)}
            className="rounded-lg border border-panel-border bg-panel-surface px-3 py-2 text-xs font-medium text-slate-300 hover:bg-panel-surface-hover hover:border-panel-accent/50 hover:text-[color:var(--panel-text)] transition-all duration-150"
            aria-label={`Run quick action ${label}`}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
