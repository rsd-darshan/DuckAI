import { useMemo, useState } from "react";
import type { ConversationItem } from "../hooks/useBackend";
import { exportConversation } from "../hooks/useBackend";

interface ConversationHistoryProps {
  items: ConversationItem[];
  query: string;
  onQueryChange: (value: string) => void;
  activeConversationId: string | null;
  onOpen: (conversationId: string) => void;
}

export function ConversationHistory({
  items,
  query,
  onQueryChange,
  activeConversationId,
  onOpen,
}: ConversationHistoryProps) {
  const emptyText = useMemo(() => (query.trim() ? "No matching conversations." : "No conversations yet."), [query]);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const runExport = async (conversationId: string, format: "markdown" | "json" | "pdf") => {
    setExportingId(conversationId);
    setNotice(null);
    try {
      const out = await exportConversation(conversationId, format);
      if (out.format === "pdf" && out.content_base64) {
        const bytes = Uint8Array.from(atob(out.content_base64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = out.filename || "conversation.pdf";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setNotice({ tone: "ok", text: "PDF downloaded." });
      } else if (out.content) {
        if (format === "markdown") {
          const blob = new Blob([out.content], { type: "text/markdown;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = out.filename || "conversation.md";
          a.rel = "noopener";
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          setNotice({ tone: "ok", text: "Markdown file saved." });
        } else {
          await navigator.clipboard.writeText(out.content);
          setNotice({ tone: "ok", text: "JSON copied to clipboard." });
        }
      } else {
        setNotice({ tone: "err", text: "Export returned no data." });
      }
    } catch (e) {
      setNotice({
        tone: "err",
        text: e instanceof Error ? e.message : "Export failed",
      });
    } finally {
      setExportingId(null);
      window.setTimeout(() => setNotice(null), 5000);
    }
  };

  return (
    <section className="flex-1 min-h-0 flex flex-col" aria-label="Conversation history">
      <div className="shrink-0 p-3 border-b border-panel-border bg-panel-bg-elevated/60 backdrop-blur-sm space-y-2">
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search conversations…"
          className="w-full rounded-lg border border-panel-border bg-panel-surface px-2.5 py-2 text-xs text-[color:var(--panel-text)] placeholder-panel-muted focus-ring"
        />
        {notice && (
          <p
            className={`text-[10px] rounded-md px-2 py-1.5 ${
              notice.tone === "ok"
                ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200 border border-emerald-500/25"
                : "bg-red-500/10 text-red-800 dark:text-red-200 border border-red-500/25"
            }`}
            role="status"
          >
            {notice.text}
          </p>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {items.length === 0 ? (
          <p className="text-xs text-panel-muted p-2 leading-relaxed">{emptyText}</p>
        ) : (
          items.map((c) => (
            <div
              key={c.id}
              className={`rounded-xl border p-3 shadow-panel motion-safe:transition-surface ${
                activeConversationId === c.id
                  ? "border-panel-accent/50 bg-panel-accent/10"
                  : "border-panel-border bg-panel-surface"
              }`}
            >
              <button type="button" onClick={() => onOpen(c.id)} className="w-full text-left focus-ring rounded-lg">
                <p className="text-xs font-semibold text-[color:var(--panel-text)] truncate">{c.title}</p>
                <p className="text-[10px] text-panel-muted truncate mt-0.5">{c.updated_at}</p>
              </button>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={exportingId === c.id}
                  onClick={() => runExport(c.id, "markdown")}
                  className="focus-ring text-[10px] font-medium px-2 py-1 rounded-lg border border-panel-border text-panel-muted hover:text-[color:var(--panel-text)] hover:bg-panel-bg disabled:opacity-50 motion-safe:transition-surface"
                >
                  {exportingId === c.id ? "…" : "MD"}
                </button>
                <button
                  type="button"
                  disabled={exportingId === c.id}
                  onClick={() => runExport(c.id, "json")}
                  className="focus-ring text-[10px] font-medium px-2 py-1 rounded-lg border border-panel-border text-panel-muted hover:text-[color:var(--panel-text)] hover:bg-panel-bg disabled:opacity-50 motion-safe:transition-surface"
                >
                  JSON
                </button>
                <button
                  type="button"
                  disabled={exportingId === c.id}
                  onClick={() => runExport(c.id, "pdf")}
                  className="focus-ring text-[10px] font-medium px-2 py-1 rounded-lg border border-panel-border text-panel-muted hover:text-[color:var(--panel-text)] hover:bg-panel-bg disabled:opacity-50 motion-safe:transition-surface"
                >
                  PDF
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
