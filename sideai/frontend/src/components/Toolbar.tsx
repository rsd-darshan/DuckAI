import { useState } from "react";

interface ToolbarProps {
  disabled?: boolean;
  suggestions?: string[];
  onSelectSuggestion?: (text: string) => void;
  onInjectChat?: (markdown: string) => void;
}

export function Toolbar({ disabled, suggestions = [], onSelectSuggestion }: ToolbarProps) {
  const [openSuggestions, setOpenSuggestions] = useState(false);

  return (
    <div className="relative z-40 shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-panel-border bg-panel-bg-elevated/40 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setOpenSuggestions((v) => !v)}
        disabled={disabled}
        className="focus-ring ml-auto text-xs font-medium px-2.5 py-1.5 rounded-lg border border-panel-border bg-panel-surface text-[color:var(--panel-text)] shadow-panel hover:border-panel-accent/30 hover:shadow-panel-md motion-safe:transition-surface disabled:opacity-50"
        title="Show suggestions"
        aria-expanded={openSuggestions}
      >
        Suggestions ({suggestions.length})
      </button>

      {openSuggestions && suggestions.length > 0 && (
        <div
          className="absolute top-[calc(100%+6px)] right-3 z-50 w-[min(280px,calc(100vw-2rem))] max-h-[min(320px,50vh)] overflow-y-auto rounded-xl border border-panel-border bg-panel-bg-elevated/95 backdrop-blur-md shadow-panel-lg p-2 space-y-1.5"
          role="menu"
        >
          {suggestions.slice(0, 4).map((s, i) => (
            <button
              key={`${s}_${i}`}
              type="button"
              role="menuitem"
              onClick={() => {
                onSelectSuggestion?.(s);
                setOpenSuggestions(false);
              }}
              className="focus-ring w-full text-left text-xs rounded-lg px-2.5 py-2.5 border border-transparent bg-panel-surface hover:bg-panel-surface-hover hover:border-panel-border text-[color:var(--panel-text)] motion-safe:transition-surface"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
