import { useState } from "react";
import { searchWeb, synthesizeAnswer } from "../hooks/useBackend";
import { useWordByWordText } from "../hooks/useWordByWordText";
import { renderMarkdownAnswer } from "../utils/renderMarkdownLite";

export interface WebSearchPanelProps {
  context: Record<string, unknown> | null;
  onUseOutput: (text: string, sources?: Array<{ title: string; url: string; snippet: string }>) => void;
}

function WebSearchAnswerArticle({ text, animate }: { text: string; animate: boolean }) {
  const { displayText, usePlainText } = useWordByWordText(text, { active: animate && !!text.trim() });
  return (
    <article className="text-xs leading-relaxed border border-panel-border bg-panel-surface rounded-lg p-3 max-h-52 min-h-[2.5rem] overflow-x-hidden overflow-y-auto break-words shadow-panel motion-safe:transition-surface">
      {usePlainText ? (
        <span className="whitespace-pre-wrap text-[color:var(--panel-text)]" aria-busy="true">
          {displayText}
        </span>
      ) : (
        renderMarkdownAnswer(text)
      )}
    </article>
  );
}

export function WebSearchPanel({ context: _screenContext, onUseOutput }: WebSearchPanelProps) {
  const [webQuery, setWebQuery] = useState("");
  /** “Sources only” button */
  const [fetchingSourcesOnly, setFetchingSourcesOnly] = useState(false);
  /** “Answer from web” → /api/synthesize */
  const [synthesizeBusy, setSynthesizeBusy] = useState(false);
  const [webHits, setWebHits] = useState<Array<{ title: string; url: string; snippet: string }>>([]);
  const [webAnswer, setWebAnswer] = useState("");
  const [webSearchError, setWebSearchError] = useState<string>("");

  const webBusy = fetchingSourcesOnly || synthesizeBusy;
  const showSourcesSkeleton = webBusy && webHits.length === 0;

  const formatWebSourcesForChat = () => {
    const q = webQuery.trim() || "web search";
    const lines = webHits.map((h, i) => {
      const title = h.title || "Untitled";
      const snip = (h.snippet || "").trim();
      return `${i + 1}. **${title}**\n${snip ? `${snip}\n` : ""}${h.url}`;
    });
    return `Web search — "${q}":\n\n${lines.join("\n\n")}`;
  };

  const showAnswerSection = Boolean(webAnswer.trim() || (webHits.length > 0 && webSearchError));

  return (
    <section className="flex-1 min-h-0 flex flex-col overflow-hidden" aria-labelledby="web-search-heading">
      <div className="shrink-0 px-3 py-2.5 border-b border-panel-border bg-panel-bg-elevated/60 backdrop-blur-sm">
        <h2 id="web-search-heading" className="text-sm font-semibold text-[color:var(--panel-text)]">
          Web search
        </h2>
        <p className="text-[11px] text-panel-muted mt-0.5 leading-snug">
          Uses only your search query and the web (not your screen). Send results to Chat when you’re ready.
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        <div className="rounded-lg border border-panel-border bg-panel-surface p-3 space-y-2">
          <p className="text-[11px] text-panel-muted leading-snug">
            Choose <span className="font-medium">Answer from web</span> for an AI reply from hits, or{" "}
            <span className="font-medium">Sources only</span> to browse links and snippets.
          </p>

          <div>
            <label htmlFor="web-search-query-panel" className="sr-only">
              Web search query
            </label>
            <input
              id="web-search-query-panel"
              value={webQuery}
              onChange={(e) => setWebQuery(e.target.value)}
              placeholder="e.g. When is Ivy Day?"
              className="w-full rounded-lg border border-panel-border bg-panel-bg px-2.5 py-2 text-xs text-panel-muted placeholder-panel-muted focus-ring"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={webBusy || !webQuery.trim()}
              onClick={async () => {
                setSynthesizeBusy(true);
                setFetchingSourcesOnly(false);
                setWebSearchError("");
                setWebAnswer("");
                setWebHits([]);
                try {
                  const { answer, hits, synthesis_error } = await synthesizeAnswer(webQuery.trim(), null, {
                    limit: 8,
                  });
                  const trimmedAnswer = (answer || "").trim();
                  setWebHits(hits || []);
                  setWebAnswer(trimmedAnswer);
                  if (synthesis_error?.trim()) {
                    setWebSearchError(synthesis_error.trim());
                  } else if (!trimmedAnswer && (!hits || hits.length === 0)) {
                    setWebSearchError("No results found. Try rephrasing your query.");
                  } else if (!trimmedAnswer && hits && hits.length > 0) {
                    setWebSearchError("Found sources but couldn't generate a summary. See links below.");
                  }
                } catch (e) {
                  setWebSearchError(e instanceof Error ? e.message : "Web search failed");
                } finally {
                  setSynthesizeBusy(false);
                }
              }}
              className="min-h-11 focus-ring text-[11px] px-2.5 py-1.5 rounded-md border border-panel-accent/60 bg-panel-accent/15 text-panel-muted hover:bg-panel-accent/25 disabled:opacity-50 motion-safe:transition-surface"
            >
              {synthesizeBusy ? "Searching web…" : "Answer from web"}
            </button>

            <button
              type="button"
              disabled={webBusy || !webQuery.trim()}
              onClick={async () => {
                setFetchingSourcesOnly(true);
                setSynthesizeBusy(false);
                setWebSearchError("");
                setWebAnswer("");
                setWebHits([]);
                try {
                  const res = await searchWeb(webQuery, 4);
                  setWebHits(res.items || []);
                } catch (e) {
                  setWebSearchError(e instanceof Error ? e.message : "Web sources lookup failed");
                } finally {
                  setFetchingSourcesOnly(false);
                }
              }}
              className="min-h-11 focus-ring text-[11px] px-2 py-1 rounded border border-panel-border text-panel-muted hover:bg-panel-bg disabled:opacity-50 motion-safe:transition-surface"
            >
              {fetchingSourcesOnly ? "Fetching…" : "Sources only"}
            </button>
          </div>

          {webSearchError && (
            <p className="text-[11px] text-red-600 dark:text-red-400 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5" role="alert">
              {webSearchError}
              {webHits.length > 0 ? (
                <span className="block mt-1 text-panel-muted font-normal">
                  Sources are listed below — you can open them or use <strong>Send sources to Chat</strong>.
                </span>
              ) : null}
            </p>
          )}

          {showAnswerSection ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[10px] uppercase tracking-wide text-panel-muted font-medium">Answer</p>
                {webAnswer.trim() ? (
                  <button
                    type="button"
                    onClick={() => onUseOutput(webAnswer, webHits)}
                    className="focus-ring text-[11px] px-2 py-1 rounded-md border border-panel-border text-panel-muted hover:text-[color:var(--panel-text)] hover:bg-panel-bg motion-safe:transition-surface min-h-9"
                  >
                    Send to Chat
                  </button>
                ) : null}
              </div>
              {webAnswer.trim() ? (
                <WebSearchAnswerArticle text={webAnswer} animate={!synthesizeBusy && !fetchingSourcesOnly} />
              ) : (
                <div className="text-[11px] text-panel-muted border border-dashed border-panel-border rounded-lg p-3 bg-panel-bg/30">
                  No AI summary for this query (see message above). Use the <strong>Sources</strong> section below.
                </div>
              )}
            </div>
          ) : null}

          {showSourcesSkeleton ? (
            <div className="space-y-2" aria-busy="true" aria-label="Loading web sources">
              <p className="text-[10px] uppercase tracking-wide text-panel-muted">Sources</p>
              <div className="space-y-1">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-panel-border bg-panel-bg/40 p-2.5 space-y-2 motion-safe:animate-pulse"
                    style={{ animationDelay: `${i * 80}ms` }}
                  >
                    <div className="h-3.5 w-[72%] rounded bg-panel-border/90" />
                    <div className="h-2.5 w-full rounded bg-panel-border/70" />
                    <div className="h-2.5 w-[88%] rounded bg-panel-border/60" />
                  </div>
                ))}
              </div>
            </div>
          ) : webHits.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[10px] uppercase tracking-wide text-panel-muted font-medium">Sources</p>
                {!webAnswer.trim() ? (
                  <button
                    type="button"
                    onClick={() => onUseOutput(formatWebSourcesForChat(), webHits)}
                    className="focus-ring shrink-0 text-[11px] px-2 py-1 rounded border border-panel-border text-panel-muted hover:bg-panel-bg motion-safe:transition-surface min-h-9"
                  >
                    Send sources to Chat
                  </button>
                ) : null}
              </div>
              <div className="space-y-1">
                {webHits.map((h, idx) => (
                  <a
                    key={`${h.url}-${idx}`}
                    href={h.url}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ring block rounded-lg border border-panel-border bg-panel-bg/40 p-2.5 hover:border-panel-accent/35 hover:shadow-panel motion-safe:transition-surface"
                  >
                    <p className="text-xs font-medium text-[color:var(--panel-text)] line-clamp-2">{h.title}</p>
                    <p className="text-[11px] text-panel-muted mt-0.5 line-clamp-2">{h.snippet}</p>
                  </a>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
