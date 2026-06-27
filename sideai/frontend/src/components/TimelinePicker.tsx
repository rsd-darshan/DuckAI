import { useEffect, useMemo, useState } from "react";
import type { ScreenContext } from "../hooks/useContext";

interface TimelinePickerProps {
  timeline: ScreenContext[];
  selectedId: string | null;
  onSelect: (item: ScreenContext | null) => void;
}

export function TimelinePicker({ timeline, selectedId, onSelect }: TimelinePickerProps) {
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);

  useEffect(() => {
    const incoming = timeline.map((t) => t.id).filter(Boolean) as string[];
    setOrderedIds((prev) => {
      const kept = prev.filter((id) => incoming.includes(id));
      const added = incoming.filter((id) => !kept.includes(id));
      return [...kept, ...added];
    });
  }, [timeline]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("sideai_timeline_order");
      if (raw) {
        const parsed = JSON.parse(raw) as string[];
        if (Array.isArray(parsed)) setOrderedIds(parsed);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("sideai_timeline_order", JSON.stringify(orderedIds));
    } catch (_) {}
  }, [orderedIds]);

  const orderedTimeline = useMemo(() => {
    const map = new Map(timeline.map((item) => [item.id, item]));
    const out: ScreenContext[] = [];
    for (const id of orderedIds) {
      const item = map.get(id);
      if (item) out.push(item);
    }
    return out.length ? out : timeline;
  }, [timeline, orderedIds]);

  const reorderByIds = (fromId: string, toId: string) => {
    setOrderedIds((prev) => {
      const base = prev.length ? [...prev] : timeline.map((t) => t.id || "").filter(Boolean);
      const from = base.indexOf(fromId);
      const to = base.indexOf(toId);
      if (from === -1 || to === -1 || from === to) return base;
      const next = [...base];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const moveByStep = (id: string, step: number) => {
    setOrderedIds((prev) => {
      const base = prev.length ? [...prev] : timeline.map((t) => t.id || "").filter(Boolean);
      const from = base.indexOf(id);
      if (from === -1) return base;
      const to = Math.max(0, Math.min(base.length - 1, from + step));
      if (from === to) return base;
      const next = [...base];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  if (!timeline.length) return null;

  return (
    <section className="shrink-0 border-b border-panel-border bg-panel-bg-elevated/50" aria-label="Context timeline">
      <div className="flex items-center justify-between px-3 pt-2">
        <h3 className="text-[10px] font-medium text-panel-muted uppercase tracking-wider">Context timeline</h3>
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="text-[11px] text-panel-muted hover:text-slate-300"
        >
          Use live
        </button>
      </div>
      <div className="px-2 pb-2 pt-1 overflow-x-auto">
        <div className="flex gap-2">
          {orderedTimeline.slice(0, 8).map((item) => {
            const label = item.window_title || item.active_app || "Snapshot";
            const short = label.length > 22 ? `${label.slice(0, 21)}...` : label;
            return (
              <div
                key={item.id ?? short}
                draggable
                onDragStart={() => setDraggedId(item.id ?? null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (draggedId && item.id) reorderByIds(draggedId, item.id);
                  setDraggedId(null);
                }}
                className={`min-w-[130px] rounded-lg border px-2 py-1.5 text-left transition-all ${
                  selectedId && selectedId === item.id
                    ? "border-panel-accent/70 bg-panel-accent/10"
                    : "border-panel-border bg-panel-surface"
                } ${draggedId === item.id ? "opacity-60 scale-[0.98]" : "opacity-100"}`}
                title={label}
              >
                <button
                  type="button"
                  onClick={() => onSelect(item)}
                  className="w-full text-left"
                  aria-label={`Select context snapshot: ${label}`}
                >
                  <p className="text-[11px] text-slate-200 truncate">{short}</p>
                  <p className="text-[10px] text-panel-muted">
                    {item.captured_at ? new Date(item.captured_at * 1000).toLocaleTimeString() : "recent"}
                  </p>
                </button>
                {item.id && (
                  <div className="mt-1 flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => moveByStep(item.id as string, -1)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-panel-border text-panel-muted hover:text-slate-200"
                      aria-label="Move snapshot left"
                    >
                      ◀
                    </button>
                    <button
                      type="button"
                      onClick={() => moveByStep(item.id as string, 1)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-panel-border text-panel-muted hover:text-slate-200"
                      aria-label="Move snapshot right"
                    >
                      ▶
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
