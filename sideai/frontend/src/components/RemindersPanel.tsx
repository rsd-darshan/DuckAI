import { useState } from "react";
import type { ReminderItem } from "../hooks/useBackend";

interface RemindersPanelProps {
  items: ReminderItem[];
  onToggleDone: (item: ReminderItem) => void;
  onCreate: (title: string, due?: string) => void;
  onSnooze?: (item: ReminderItem, minutes: number) => void | Promise<void>;
  /** Nested inside another card — drops outer chrome so borders don’t stack. */
  embedded?: boolean;
}

export function RemindersPanel({ items, onToggleDone, onCreate, onSnooze, embedded }: RemindersPanelProps) {
  const [title, setTitle] = useState("");
  const [dueInput, setDueInput] = useState("");

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onCreate(trimmed, dueInput || undefined);
    setTitle("");
    setDueInput("");
  };

  const formatDue = (item: ReminderItem) => {
    if (item.due_at) return new Date(item.due_at * 1000).toLocaleString();
    return item.due || "";
  };

  const isOverdue = (item: ReminderItem) => Boolean(item.due_at && !item.done && item.due_at * 1000 < Date.now());

  const shell = embedded
    ? "bg-panel-bg/50 border-0"
    : "shrink-0 border-b border-panel-border bg-panel-bg-elevated/40";

  return (
    <section className={shell} aria-label="Reminders">
      <div className={`flex items-center justify-between ${embedded ? "px-2 pt-2 pb-1" : "px-3 pt-2.5 pb-1.5"}`}>
        <h3 className="text-[10px] font-semibold text-panel-muted uppercase tracking-wider">
          Reminders
        </h3>
        <span className="text-[10px] tabular-nums text-panel-muted">{items.filter((i) => !i.done).length} open</span>
      </div>
      <div className={`space-y-1.5 ${embedded ? "px-2 pb-1" : "px-2 pb-2"}`}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="What to remember?"
          className="studio-input w-full"
          aria-label="Reminder title"
        />
        <div className="flex items-center gap-1.5">
          <input
            type="datetime-local"
            value={dueInput}
            onChange={(e) => setDueInput(e.target.value)}
            className="studio-input flex-1 min-w-0"
            aria-label="Reminder due date and time"
          />
          <button
            type="button"
            onClick={submit}
            className="studio-btn-primary shrink-0 rounded-md px-2.5 py-1.5 text-xs"
            aria-label="Create reminder"
          >
            Add
          </button>
        </div>
      </div>
      <ul className={`space-y-1.5 max-h-36 overflow-y-auto ${embedded ? "px-2 pb-2" : "px-2 pb-2.5"}`}>
        {items.length === 0 && (
          <li className="list-none text-[11px] text-panel-muted py-1 px-0.5">No reminders yet — add one above.</li>
        )}
        {items.slice(0, 8).map((item) => (
          <li key={item.id} className="rounded-lg border border-panel-border bg-panel-surface px-2 py-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onToggleDone(item)}
              className={`h-4 w-4 shrink-0 rounded border motion-safe:transition-colors ${item.done ? "bg-emerald-500 border-emerald-500" : "border-panel-border hover:border-panel-accent/40"}`}
              aria-label={item.done ? "Mark incomplete" : "Mark complete"}
            />
            <div className="min-w-0 flex-1">
              <p className={`text-xs truncate ${item.done ? "line-through text-panel-muted" : "text-[color:var(--panel-text)]"}`}>{item.title}</p>
              {(item.due || item.due_at) && (
                <p className={`text-[10px] ${isOverdue(item) ? "text-rose-400" : "text-amber-400"}`}>
                  {isOverdue(item) ? "Overdue: " : "Due: "}
                  {formatDue(item)}
                </p>
              )}
            </div>
            {onSnooze && !item.done && (item.due_at || item.due) ? (
              <button
                type="button"
                className="shrink-0 studio-btn-secondary py-0.5 px-1.5 text-[10px]"
                title="Snooze notifications 10 minutes"
                onClick={() => onSnooze(item, 10)}
              >
                +10m
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
