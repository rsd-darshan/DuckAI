import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { isEmailContext as detectEmailContext } from "../utils/appContext";
import { resolveReadableContent } from "../utils/resolveReadableContent";
import { triggerScreenCapture } from "../utils/triggerScreenCapture";

const API = "http://127.0.0.1:8000";
const SUMMARIZE_TIMEOUT_MS = 30_000;

interface Props {
  screenText?: string;
  windowTitle?: string;
  activeApp?: string;
}

interface Summary {
  title: string;
  type: string;
  summary: string;
  key_points: string[];
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  url?: string;
  video_id?: string;
  error?: string;
  message?: string;
}

const SENTIMENT_COLOR: Record<string, string> = {
  positive: "var(--semantic-success-text)",
  negative: "var(--semantic-danger-text)",
  mixed: "var(--semantic-warn-text)",
  neutral: "var(--panel-muted)",
};

const SENTIMENT_BG: Record<string, string> = {
  positive: "rgba(34, 197, 94, 0.15)",
  negative: "rgba(239, 68, 68, 0.15)",
  mixed: "rgba(202, 138, 4, 0.15)",
  neutral: "rgba(107, 114, 128, 0.12)",
};

function isYouTubeUrl(url: string) {
  return /(?:youtube\.com\/(?:watch|embed|shorts|clip|live)|youtu\.be\/)/.test(url);
}

function isPrivateUrl(url: string) {
  return /mail\.google\.com|outlook\.(live|office)\.com|localhost|127\.0\.0\.1/.test(url);
}

function getDomain(url: string) {
  try { return new URL(url).hostname.replace("www.", ""); } catch { return url; }
}

export function SummarizePanel({ screenText = "", windowTitle = "", activeApp = "" }: Props) {
  const [detectedUrl, setDetectedUrl] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resolvedPreview, setResolvedPreview] = useState("");
  const [manualText, setManualText] = useState("");
  const [showPasteText, setShowPasteText] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pasteTextRef = useRef<HTMLTextAreaElement>(null);

  // Track in-flight requests to avoid stale results overwriting newer ones
  const summarizeIdRef = useRef(0);
  const [loadStep, setLoadStep] = useState(0);

  useEffect(() => {
    if (showInput) setTimeout(() => inputRef.current?.focus(), 50);
  }, [showInput]);

  useEffect(() => {
    if (showPasteText) setTimeout(() => pasteTextRef.current?.focus(), 60);
  }, [showPasteText]);

  const activeUrl = manualUrl.trim() || detectedUrl || "";
  const isYT = activeUrl ? isYouTubeUrl(activeUrl) : false;
  const isPrivate = activeUrl ? isPrivateUrl(activeUrl) : false;
  const isEmail = detectEmailContext(activeApp, windowTitle, activeUrl, screenText);
  const hasScreenText = screenText.trim().length > 70 || resolvedPreview.length > 70;

  const LOAD_STEPS = useMemo(() =>
    isYT
      ? ["Fetching transcript…", "Analyzing video…", "Writing summary…", "Almost done…"]
      : isEmail
        ? ["Reading email…", "Understanding content…", "Writing summary…", "Almost done…"]
        : ["Reading page…", "Analyzing content…", "Writing summary…", "Almost done…"],
    [isYT, isEmail]
  );

  useEffect(() => {
    if (!loading) { setLoadStep(0); return; }
    const id = setInterval(() => setLoadStep((s) => Math.min(s + 1, LOAD_STEPS.length - 1)), 2200);
    return () => clearInterval(id);
  }, [loading, LOAD_STEPS.length]);

  // Only fetch browser URL when not in email context (private includes Gmail)
  useEffect(() => {
    if (isEmail) return;
    fetch(`${API}/api/browser_url`)
      .then((r) => r.json())
      .then((d) => { if (d.url) setDetectedUrl(d.url); })
      .catch(() => {});
  }, [isEmail]);

  const loadPreview = useCallback(async () => {
    const r = await resolveReadableContent({
      screenText,
      windowTitle,
      activeApp,
      purpose: "summarize",
      forceFresh: false,
    });
    if (r.sufficient) setResolvedPreview(r.text);
  }, [screenText, windowTitle, activeApp]);

  useEffect(() => {
    if (isEmail || isPrivate) void loadPreview();
  }, [isEmail, isPrivate, loadPreview]);

  async function summarize(url?: string, pastedText?: string) {
    const id = ++summarizeIdRef.current;
    const target = url ?? activeUrl;
    setLoading(true);
    setSummary(null);
    setShowPasteText(false);

    // If the user pasted text manually, skip capture and summarize directly
    if (pastedText && pastedText.trim().length >= 40) {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), SUMMARIZE_TIMEOUT_MS);
      try {
        const r2 = await fetch(`${API}/api/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: pastedText.trim(), title: windowTitle || "Pasted content", window_title: windowTitle, active_app: activeApp, screen_text: screenText }),
          signal: controller2.signal,
        });
        clearTimeout(timer2);
        if (summarizeIdRef.current !== id) return;
        const data = r2.ok ? await r2.json() as Summary : null;
        setSummary(data ?? { title: "Error", type: "text", summary: "Something went wrong.", key_points: [], sentiment: "neutral", error: "backend_error" });
      } catch {
        clearTimeout(timer2);
        if (summarizeIdRef.current === id) setSummary({ title: "Error", type: "text", summary: "Request failed.", key_points: [], sentiment: "neutral", error: "network" });
      } finally {
        if (summarizeIdRef.current === id) setLoading(false);
      }
      return;
    }

    if (!url && (isEmail || isPrivate || !target)) {
      await triggerScreenCapture();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);

    try {
      let body: Record<string, unknown>;

      if ((isEmail || isPrivate) && !url && !isYT) {
        const resolved = await resolveReadableContent({
          screenText,
          windowTitle,
          activeApp,
          purpose: "summarize",
          forceFresh: true,
        });
        const text = resolved.text.trim();
        if (!resolved.sufficient || text.length < 40) {
          if (summarizeIdRef.current !== id) return;
          setSummary({
            title: resolved.guidance?.title || "Could not read content",
            type: "email",
            summary: resolved.guidance?.message || "Open the email body and click ↻ Refresh capture to try again.",
            key_points: resolved.guidance?.bullets ?? [],
            sentiment: "neutral",
            error: "no_content",
            message: resolved.guidance?.message,
          });
          setLoading(false);
          return;
        }
        body = {
          text,
          screen_text: screenText,
          title: windowTitle || "Email",
          window_title: windowTitle,
          active_app: activeApp,
          content_type: "email",
        };
      } else if (!target) {
        const resolved = await resolveReadableContent({
          screenText,
          windowTitle,
          activeApp,
          purpose: "summarize",
          forceFresh: !hasScreenText,
        });
        if (resolved.sufficient && resolved.text.length >= 40) {
          body = {
            text: resolved.text,
            screen_text: screenText,
            title: windowTitle,
            window_title: windowTitle,
            active_app: activeApp,
          };
        } else if (hasScreenText) {
          body = {
            text: resolvedPreview || screenText.trim(),
            screen_text: screenText,
            title: windowTitle,
            window_title: windowTitle,
            active_app: activeApp,
          };
        } else {
          if (summarizeIdRef.current !== id) return;
          setShowInput(true);
          setLoading(false);
          return;
        }
      } else {
        body = {
          url: target,
          window_title: windowTitle,
          active_app: activeApp,
          screen_text: screenText,
        };
      }

      const r = await fetch(`${API}/api/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (summarizeIdRef.current !== id) return;

      if (!r.ok) {
        const errBody = await r.json().catch(() => ({})) as { message?: string; detail?: string };
        setSummary({
          title: "Error",
          type: "webpage",
          summary: errBody.message || errBody.detail || `Something went wrong (${r.status}). Try again.`,
          key_points: [],
          sentiment: "neutral",
          error: "backend_error",
        });
        setLoading(false);
        return;
      }

      const data = await r.json() as Summary;
      if (summarizeIdRef.current !== id) return;
      setSummary(data);
    } catch (e) {
      clearTimeout(timer);
      if (summarizeIdRef.current !== id) return;
      if (e instanceof Error && e.name === "AbortError") {
        setSummary({
          title: "Timed out",
          type: "webpage",
          summary: "Summarization took too long. Try again or paste a different URL.",
          key_points: [],
          sentiment: "neutral",
          error: "timeout",
        });
      } else {
        setSummary({
          title: "Network error",
          type: "webpage",
          summary: "Could not reach the backend. Make sure DuckAI is running.",
          key_points: [],
          sentiment: "neutral",
          error: "network",
        });
      }
    } finally {
      if (summarizeIdRef.current === id) setLoading(false);
    }
  }

  async function copyText() {
    if (!summary || summary.error) return;
    const pts = summary.key_points.map((p) => `• ${p}`).join("\n");
    const text = `${summary.title}\n\n${summary.summary}${pts ? `\n\nKey points:\n${pts}` : ""}`;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  const buttonLabel = isYT ? "Summarize video" : isEmail || isPrivate ? "Summarize email" : "Summarize page";

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <button
          onClick={() => void summarize()}
          disabled={loading}
          className="flex-1 rounded-xl py-2 text-sm font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50"
          style={{ background: "var(--panel-accent)", color: "var(--accent-text)" }}
        >
          {loading ? (
            <>
              <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              <span className="transition-all duration-300">{LOAD_STEPS[loadStep]}</span>
            </>
          ) : (
            <>
              {isYT ? <YoutubeIcon /> : isEmail || isPrivate ? <MailIcon /> : <ArticleIcon />}
              {buttonLabel}
            </>
          )}
        </button>
        <button
          onClick={() => setShowInput((v) => !v)}
          title="Paste a different URL"
          className="h-9 w-9 flex items-center justify-center rounded-xl transition-all shrink-0"
          style={{
            background: showInput ? "color-mix(in srgb, var(--panel-accent) 12%, transparent)" : "var(--panel-surface-hover)",
            border: showInput ? "1px solid color-mix(in srgb, var(--panel-accent) 25%, transparent)" : "1px solid var(--panel-border)",
            color: showInput ? "var(--panel-accent)" : "var(--panel-muted)",
          }}
        >
          <LinkIcon />
        </button>
      </div>

      {(activeUrl || isEmail || hasScreenText) && !showInput && (
        <div
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg"
          style={{ background: "var(--panel-surface)", border: "1px solid var(--panel-border)" }}
        >
          {isYT ? <YoutubeIcon /> : isEmail || isPrivate ? <MailIcon /> : <GlobeSmIcon />}
          <span className="text-[10px] truncate flex-1" style={{ color: "var(--panel-text-muted)" }}>
            {isEmail || isPrivate
              ? windowTitle || getDomain(activeUrl) || "Email on screen"
              : activeUrl.length > 55
                ? `${activeUrl.slice(0, 55)}…`
                : activeUrl || "Screen content"}
          </span>
        </div>
      )}

      {showInput && (
        <div className="flex gap-1.5">
          <input
            ref={inputRef}
            type="url"
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const trimmed = manualUrl.trim();
                if (trimmed.length >= 5) {
                  void summarize(trimmed || undefined);
                  setShowInput(false);
                }
              }
            }}
            placeholder={detectedUrl ?? "Paste a URL to summarize…"}
            className="field text-[11px] flex-1"
          />
          <button
            onClick={() => {
              const trimmed = manualUrl.trim();
              if (trimmed.length >= 5) {
                void summarize(trimmed || undefined);
                setShowInput(false);
              }
            }}
            disabled={loading}
            className="shrink-0 px-3 rounded-lg text-xs font-semibold disabled:opacity-50"
            style={{ background: "var(--panel-accent)", color: "var(--accent-text)" }}
          >
            Go
          </button>
        </div>
      )}

      {summary?.error && (
        <div className="flex flex-col gap-2">
          <div
            className="flex flex-col gap-2 rounded-xl px-3 py-2.5 text-[11px] leading-snug"
            style={{
              background: summary.error === "no_content" ? "var(--semantic-warn-bg)" : "var(--semantic-danger-bg)",
              color: summary.error === "no_content" ? "var(--semantic-warn-text)" : "var(--semantic-danger-text)",
              border: `1px solid ${summary.error === "no_content" ? "var(--semantic-warn-border)" : "var(--semantic-danger-border)"}`,
            }}
          >
            <p>{summary.message || summary.summary || "Something went wrong."}</p>
            {summary.error === "no_content" && (
              <button
                type="button"
                onClick={() => setShowPasteText((v) => !v)}
                className="self-start text-[10px] font-semibold rounded-lg px-2.5 py-1.5 transition-all"
                style={{ background: "color-mix(in srgb, currentColor 12%, transparent)", border: "1px solid currentColor", opacity: 0.9 }}
              >
                {showPasteText ? "Hide paste" : "Paste text instead →"}
              </button>
            )}
          </div>

          {showPasteText && summary.error === "no_content" && (
            <div className="flex flex-col gap-1.5 animate-fade-up">
              <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--panel-muted)" }}>
                Paste content to summarize
              </label>
              <textarea
                ref={pasteTextRef}
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder="Paste the email or article text here…"
                rows={5}
                className="field text-[11px] resize-none"
                style={{ minHeight: "100px" }}
              />
              <button
                type="button"
                onClick={() => { if (manualText.trim().length >= 40) void summarize(undefined, manualText.trim()); }}
                disabled={loading || manualText.trim().length < 40}
                className="w-full rounded-xl py-2 text-sm font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-40"
                style={{ background: "var(--panel-accent)", color: "var(--accent-text)" }}
              >
                {loading ? (
                  <><span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" /> Summarizing…</>
                ) : (
                  "Summarize pasted text"
                )}
              </button>
            </div>
          )}
          {summary.key_points.length > 0 && (
            <ul className="text-[10px] text-panel-muted list-disc pl-4 space-y-0.5">
              {summary.key_points.map((pt) => (
                <li key={pt}>{pt}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {summary && !summary.error && (
        <div
          className="flex flex-col gap-2.5 rounded-xl p-3"
          style={{ background: "var(--panel-surface-hover)", border: "1px solid var(--panel-border)" }}
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              {summary.title && (
                <p className="text-[12px] font-semibold leading-snug mb-1 line-clamp-2" style={{ color: "var(--panel-text)" }}>
                  {summary.title}
                </p>
              )}
              <div className="flex items-center gap-1.5">
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-md font-medium capitalize"
                  style={{
                    background: SENTIMENT_BG[summary.sentiment] ?? SENTIMENT_BG.neutral,
                    color: SENTIMENT_COLOR[summary.sentiment] ?? SENTIMENT_COLOR.neutral,
                  }}
                >
                  {summary.sentiment}
                </span>
                {summary.url && (
                  <span className="text-[10px] truncate" style={{ color: "var(--panel-muted)" }}>
                    {getDomain(summary.url)}
                  </span>
                )}
              </div>
            </div>
          </div>

          <p className="text-[12px] leading-relaxed" style={{ color: "var(--panel-text-muted)" }}>
            {summary.summary}
          </p>

          {summary.key_points.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="section-title">Key points</p>
              {summary.key_points.map((pt, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <span className="mt-[5px] shrink-0 w-1 h-1 rounded-full" style={{ background: "var(--panel-accent)", minWidth: "4px" }} />
                  <p className="text-[11px] leading-snug" style={{ color: "var(--panel-text)" }}>{pt}</p>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2 pt-0.5">
            <button
              onClick={() => void copyText()}
              className="flex-1 rounded-lg py-1.5 text-xs font-semibold transition-all"
              style={
                copied
                  ? { background: "var(--semantic-success-bg)", color: "var(--semantic-success-text)", border: "1px solid var(--semantic-success-border)" }
                  : { background: "var(--panel-accent)", color: "var(--accent-text)", border: "1px solid transparent" }
              }
            >
              {copied ? "✓ Copied!" : "Copy summary"}
            </button>
            <button
              onClick={() => void summarize()}
              disabled={loading}
              title="Re-summarize"
              className="px-3 rounded-lg text-sm transition-all disabled:opacity-40"
              style={{ background: "var(--panel-surface-hover)", color: "var(--panel-text-muted)", border: "1px solid var(--panel-border)" }}
            >
              ↺
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function YoutubeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-2.75 12.64 12.64 0 0 0-7.64 0A4.83 4.83 0 0 1 4.41 6.69 49.1 49.1 0 0 0 3 12a49.1 49.1 0 0 0 1.41 5.31 4.83 4.83 0 0 1 3.77 2.75 12.64 12.64 0 0 0 7.64 0 4.83 4.83 0 0 1 3.77-2.75A49.1 49.1 0 0 0 21 12a49.1 49.1 0 0 0-1.41-5.31ZM10 15.5v-7l5 3.5-5 3.5Z" />
    </svg>
  );
}

function ArticleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M5.625 1.5H9a3.75 3.75 0 0 1 3.75 3.75v1.875c0 1.036.84 1.875 1.875 1.875H16.5a3.75 3.75 0 0 1 3.75 3.75v7.875c0 1.035-.84 1.875-1.875 1.875H5.625a1.875 1.875 0 0 1-1.875-1.875V3.375c0-1.036.84-1.875 1.875-1.875ZM9.75 14.25a.75.75 0 0 0 0 1.5H15a.75.75 0 0 0 0-1.5H9.75Zm0-3a.75.75 0 0 0 0 1.5H15a.75.75 0 0 0 0-1.5H9.75Z" clipRule="evenodd" />
      <path d="M14.25 5.25a5.23 5.23 0 0 0-1.279-3.434 9.768 9.768 0 0 1 6.963 6.963A5.23 5.23 0 0 0 16.5 7.5h-1.875a.375.375 0 0 1-.375-.375V5.25Z" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M19.902 4.098a3.75 3.75 0 0 0-5.304 0l-4.5 4.5a3.75 3.75 0 0 0 1.035 6.037.75.75 0 0 1-.646 1.353 5.25 5.25 0 0 1-1.449-8.45l4.5-4.5a5.25 5.25 0 1 1 7.424 7.424l-1.757 1.757a.75.75 0 1 1-1.06-1.06l1.757-1.757a3.75 3.75 0 0 0 0-5.304Zm-7.533 7.533a.75.75 0 0 1 1.06 0 3.75 3.75 0 0 1 0 5.304l-4.5 4.5a5.25 5.25 0 0 1-7.424-7.424l1.757-1.757a.75.75 0 1 1 1.06 1.06l-1.757 1.757a3.75 3.75 0 1 0 5.304 5.304l4.5-4.5a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--panel-muted)", flexShrink: 0 }} aria-hidden>
      <path d="M1.5 8.67v8.58a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3V8.67l-8.928 5.493a3 3 0 0 1-3.144 0L1.5 8.67Z" />
      <path d="M22.5 6.908V6.75a3 3 0 0 0-3-3h-15a3 3 0 0 0-3 3v.158l9.714 5.978a1.5 1.5 0 0 0 1.572 0L22.5 6.908Z" />
    </svg>
  );
}

function GlobeSmIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--panel-muted)", flexShrink: 0 }} aria-hidden>
      <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM8.547 10.5a4.5 4.5 0 0 1 .26-1.277c.41-1.099 1.187-1.973 2.193-1.973.906 0 1.5.907 1.5 1.75 0 1.286-.876 1.75-1.5 2-.726.293-1.5.786-1.5 1.75v.5h1.5v-.5c0-.293.774-.707 1.5-1 1.124-.45 1.5-1.714 1.5-2.75 0-1.793-1.344-3.25-3-3.25-1.806 0-3.007 1.35-3.453 2.723A6 6 0 0 0 7.5 10.5h1.047ZM12 16.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" clipRule="evenodd" />
    </svg>
  );
}
