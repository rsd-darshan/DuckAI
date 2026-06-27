import { useEffect, useMemo, useRef, useState } from "react";

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: CommandItem[];
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(s) || c.id.includes(s));
  }, [commands, q]);

  useEffect(() => {
    if (!open) {
      setQ("");
      return;
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh] px-3 bg-black/40 backdrop-blur-[2px]"
      role="dialog"
      aria-label="Command palette"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-panel-border bg-panel-bg-elevated shadow-panel-lg overflow-hidden motion-safe:transition-surface">
        <div className="border-b border-panel-border px-3 py-2">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to tab, change theme, transparency…"
            className="w-full bg-transparent text-sm text-[color:var(--panel-text)] placeholder:text-panel-muted outline-none"
            aria-label="Filter commands"
          />
          <p className="text-[10px] text-panel-muted mt-1">⌘K / Ctrl+K · Esc to close</p>
        </div>
        <ul className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-xs text-panel-muted">No matches</li>
          )}
          {filtered.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-xs hover:bg-panel-surface/80 text-[color:var(--panel-text)]"
                onClick={() => {
                  c.run();
                  onClose();
                }}
              >
                <span className="font-medium">{c.label}</span>
                {c.hint ? <span className="block text-[10px] text-panel-muted mt-0.5">{c.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
