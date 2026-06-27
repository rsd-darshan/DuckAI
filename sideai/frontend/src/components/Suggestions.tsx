import { useState } from "react";
import { typeText } from "../hooks/useBackend";

interface SuggestionsProps {
  suggestions: string[];
  onSelect?: (text: string) => void;
  onActionPrompt?: (prompt: string) => void;
  collapsed?: boolean;
}

export function Suggestions({
  suggestions,
  onSelect,
  onActionPrompt,
  collapsed,
}: SuggestionsProps) {
  const [writingIndex, setWritingIndex] = useState<number | null>(null);

  const handleWrite = async (text: string, i: number) => {
    setWritingIndex(i);
    try {
      await typeText(text, { delaySeconds: 2 });
    } finally {
      setWritingIndex(null);
    }
  };

  if (collapsed || suggestions.length === 0) return null;

  return (
    <section
      className="shrink-0 border-b border-panel-border bg-panel-bg-elevated/80"
      aria-label="Suggestions"
    >
      <h3 className="text-[10px] font-medium text-panel-muted uppercase tracking-wider px-3 pt-2.5 pb-1.5">
        Suggestions
      </h3>
      <ul className="px-2 pb-2.5 space-y-1">
        {suggestions.map((s, i) => (
          <li key={i} className="group rounded-xl border border-panel-border/70 bg-panel-surface/70 p-2 space-y-2">
            <button
              type="button"
              onClick={() => onSelect?.(s)}
              className="w-full min-w-0 text-left text-sm text-slate-300 hover:text-[color:var(--panel-text)] rounded-lg px-2 py-1.5 transition-all duration-200 group-hover:bg-panel-bg-elevated/50"
            >
              {s}
            </button>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onActionPrompt?.(`Write a polite response for this context: ${s}`)}
                className="text-[11px] px-2 py-1 rounded-md border border-panel-border text-panel-muted hover:text-slate-200 hover:border-sky-400/50 hover:bg-sky-500/10 transition-all"
                aria-label="Reply politely action"
              >
                <span className="mr-1">💬</span>Reply politely
              </button>
              <button
                type="button"
                onClick={() => onActionPrompt?.(`Summarize this into 3 bullets: ${s}`)}
                className="text-[11px] px-2 py-1 rounded-md border border-panel-border text-panel-muted hover:text-slate-200 hover:border-indigo-400/50 hover:bg-indigo-500/10 transition-all"
                aria-label="Summarize action"
              >
                <span className="mr-1">🧠</span>Summarize
              </button>
              <button
                type="button"
                onClick={() => onActionPrompt?.(`Turn this into a concise checklist: ${s}`)}
                className="text-[11px] px-2 py-1 rounded-md border border-panel-border text-panel-muted hover:text-slate-200 hover:border-emerald-400/50 hover:bg-emerald-500/10 transition-all"
                aria-label="Checklist action"
              >
                <span className="mr-1">✅</span>Checklist
              </button>
              <button
                type="button"
                onClick={() => handleWrite(s, i)}
                disabled={writingIndex !== null}
                className="ml-auto shrink-0 p-1.5 rounded-md hover:bg-panel-surface text-panel-muted hover:text-slate-300 disabled:opacity-50 transition-transform hover:scale-105"
                title="Write to focused field"
                aria-label="Write to screen"
              >
                {writingIndex === i ? <span className="text-xs">...</span> : <PencilIcon />}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PencilIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
      <path d="M21.731 2.269a2.625 2.625 0 0 0-3.712 0l-1.157 1.157 3.712 3.712 1.157-1.157a2.625 2.625 0 0 0 0-3.712ZM19.513 8.199l-3.712-3.712-8.4 8.4a5.25 5.25 0 0 0-1.32 2.214l-.8 2.685a.75.75 0 0 0 .933.933l2.685-.8a5.25 5.25 0 0 0 2.214-1.32l8.4-8.4Z" />
    </svg>
  );
}
