import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { isEmailContext } from "../utils/appContext";
import { resolveReadableContent } from "../utils/resolveReadableContent";
import type { CaptureGuidance } from "../utils/captureGuidance";

const API = "http://127.0.0.1:8000";
const DRAFT_TIMEOUT_MS = 30_000;
const TONES = ["professional", "friendly", "concise", "formal", "casual"] as const;
type Tone = typeof TONES[number];

interface Props {
  screenText?: string;
  windowTitle?: string;
  activeApp?: string;
}

export function EmailDraftPanel({ screenText = "", windowTitle = "", activeApp = "" }: Props) {
  const [tone, setTone] = useState<Tone>("professional");
  const [emailText, setEmailText] = useState("");
  const [fetching, setFetching] = useState(true);
  const [guidance, setGuidance] = useState<CaptureGuidance | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  // Track in-flight request IDs to avoid stale results overwriting newer ones
  const generateIdRef = useRef(0);
  const [loadStep, setLoadStep] = useState(0);

  const LOAD_STEPS = useMemo(() => [
    "Reading email…",
    "Understanding context…",
    `Drafting ${tone} reply…`,
    "Polishing…",
  ], [tone]);

  useEffect(() => {
    if (!loading) { setLoadStep(0); return; }
    const id = setInterval(() => setLoadStep((s) => Math.min(s + 1, LOAD_STEPS.length - 1)), 2000);
    return () => clearInterval(id);
  }, [loading, LOAD_STEPS.length]);

  const loadContent = useCallback(async (forceFresh = false) => {
    setFetching(true);
    setGuidance(null);
    setError("");
    const resolved = await resolveReadableContent({
      screenText,
      windowTitle,
      activeApp,
      purpose: "email_draft",
      forceFresh,
    });
    setEmailText(resolved.text);
    if (resolved.guidance) {
      setGuidance(resolved.guidance);
    } else if (!resolved.sufficient && resolved.text.length < 55) {
      setGuidance({
        kind: "empty",
        title: "Could not read email",
        message: "Make sure the email body is fully visible and try again.",
      });
    }
    setFetching(false);
  }, [screenText, windowTitle, activeApp]);

  useEffect(() => {
    void loadContent(false);
  }, [loadContent]);

  // Use manually pasted email as fallback when OCR didn't capture enough
  const effectiveEmail = manualEmail.trim().length >= 55 ? manualEmail.trim() : emailText;
  const hasContent = effectiveEmail.length >= 55;
  const inEmailContext = isEmailContext(activeApp, windowTitle, "", screenText || emailText) || manualEmail.trim().length >= 55;

  useEffect(() => {
    if (showPaste) setTimeout(() => pasteRef.current?.focus(), 60);
  }, [showPaste]);

  async function generate() {
    const id = ++generateIdRef.current;
    setLoading(true);
    setError("");
    setDraft("");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS);

    try {
      const r = await fetch(`${API}/api/email/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_text: effectiveEmail,
          tone,
          screen_text: screenText,
          window_title: windowTitle,
          active_app: activeApp,
          force_fresh: !hasContent,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Discard if a newer request already fired
      if (generateIdRef.current !== id) return;

      if (!r.ok) {
        const errBody = await r.json().catch(() => ({})) as { message?: string; detail?: string };
        setError(errBody.message || errBody.detail || `Server error (${r.status}). Try refreshing capture.`);
        setLoading(false);
        return;
      }

      const d = await r.json() as { reply?: string; tone?: string; error?: string; message?: string };

      if (generateIdRef.current !== id) return;

      const reply = (d.reply || "").trim();

      if (d.error === "no_content" || !reply) {
        setError(d.message || "Could not read enough email content to draft a reply.");
        setLoading(false);
        // Trigger a fresh capture in background so next attempt works
        if (!hasContent) void loadContent(true);
        return;
      }

      setDraft(reply);
      // Sync tone badge to what was actually used
      if (d.tone && (TONES as readonly string[]).includes(d.tone)) {
        setTone(d.tone as Tone);
      }
    } catch (e) {
      clearTimeout(timer);
      if (generateIdRef.current !== id) return;
      if (e instanceof Error && e.name === "AbortError") {
        setError("Draft took too long. The AI may be busy — try again in a moment.");
      } else {
        setError(`Something went wrong: ${e}`);
      }
    } finally {
      if (generateIdRef.current === id) setLoading(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }


  return (
    <div className="flex flex-col gap-2.5">
      {!fetching && !inEmailContext && (
        <div
          className="rounded-lg px-3 py-2.5 text-[11px] leading-snug"
          style={{
            background: "var(--semantic-warn-bg)",
            border: "1px solid var(--semantic-warn-border)",
            color: "var(--semantic-warn-text)",
          }}
        >
          <p className="font-semibold">Not in an email app</p>
          <p>Open Gmail or Mail and make sure the full email body is visible, then try again.</p>
        </div>
      )}

      {fetching && (
        <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--panel-muted)" }}>
          <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0" />
          Reading email…
        </div>
      )}

      {!fetching && guidance && guidance.kind !== "none" && !hasContent && (
        <div
          className="flex flex-col gap-2 rounded-xl px-3 py-2.5 text-[11px] leading-snug"
          style={{
            background: "var(--semantic-warn-bg)",
            border: "1px solid var(--semantic-warn-border)",
            color: "var(--semantic-warn-text)",
          }}
        >
          <div>
            <p className="font-semibold">{guidance.title}</p>
            <p className="mt-0.5 opacity-90">{guidance.message}</p>
          </div>
          <button
            type="button"
            onClick={() => setShowPaste((v) => !v)}
            className="self-start text-[10px] font-semibold rounded-lg px-2.5 py-1.5 transition-all"
            style={{
              background: showPaste
                ? "color-mix(in srgb, var(--panel-accent) 15%, transparent)"
                : "color-mix(in srgb, currentColor 10%, transparent)",
              border: "1px solid currentColor",
              opacity: 0.9,
            }}
          >
            {showPaste ? "Hide paste" : "Paste email instead →"}
          </button>
        </div>
      )}

      {!fetching && showPaste && !hasContent && (
        <div className="flex flex-col gap-1.5 animate-fade-up">
          <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--panel-muted)" }}>
            Paste email content
          </label>
          <textarea
            ref={pasteRef}
            value={manualEmail}
            onChange={(e) => setManualEmail(e.target.value)}
            placeholder="Paste the email text here…"
            rows={5}
            className="field text-[11px] resize-none"
            style={{ minHeight: "100px" }}
          />
          {manualEmail.trim().length > 0 && manualEmail.trim().length < 55 && (
            <p className="text-[10px]" style={{ color: "var(--panel-muted)" }}>
              Paste a bit more — need at least a sentence or two.
            </p>
          )}
          {manualEmail.trim().length >= 55 && (
            <p className="text-[10px]" style={{ color: "var(--semantic-success-text)" }}>
              ✓ Ready to draft
            </p>
          )}
        </div>
      )}

      {!fetching && hasContent && !showPaste && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--panel-muted)" }}>
            {manualEmail.trim().length >= 55 ? "Email (pasted)" : "Email ready"}
          </span>
          <p className="text-[11px] leading-snug line-clamp-3" style={{ color: "var(--panel-text-muted)" }}>
            {effectiveEmail.slice(0, 200)}{effectiveEmail.length > 200 ? "…" : ""}
          </p>
        </div>
      )}

      {!fetching && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--panel-muted)" }}>
            Tone
          </span>
          <div className="flex flex-wrap gap-1">
            {TONES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTone(t)}
                className="text-[10px] px-2.5 py-1 rounded-full capitalize font-medium transition-all motion-safe:transition-surface"
                style={
                  tone === t
                    ? {
                        background: "linear-gradient(135deg, var(--panel-accent), color-mix(in srgb, var(--panel-accent-2,#a855f7) 40%, var(--panel-accent)))",
                        color: "var(--accent-text)",
                        border: "1px solid transparent",
                      }
                    : {
                        background: "transparent",
                        color: "var(--panel-muted)",
                        border: "1px solid var(--panel-border)",
                      }
                }
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}

      {!fetching && (
        <button
          type="button"
          onClick={() => void generate()}
          disabled={loading || !inEmailContext || emailText.trim().length < 55}
          className="w-full rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50"
          style={{ background: "var(--panel-accent)", color: "var(--accent-text)" }}
        >
          {loading ? (
            <>
              <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              <span className="transition-all duration-300">{LOAD_STEPS[loadStep]}</span>
            </>
          ) : (
            <>
              <PencilIcon />
              Draft Reply
              <span
                className="ml-auto text-[10px] font-normal opacity-70 capitalize"
                style={{ color: "var(--accent-text)" }}
              >
                {tone}
              </span>
            </>
          )}
        </button>
      )}

      {error && (
        <p
          className="text-[11px] rounded-lg px-3 py-2 leading-snug"
          style={{ background: "var(--semantic-danger-bg)", color: "var(--semantic-danger-text)", border: "1px solid var(--semantic-danger-border)" }}
        >
          {error}
        </p>
      )}

      {draft && (
        <div className="flex flex-col gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--panel-muted)" }}>
            Draft
          </p>
          <div
            className="rounded-xl p-3 text-sm leading-relaxed whitespace-pre-wrap"
            style={{ background: "var(--panel-surface-hover)", border: "1px solid var(--panel-border)", color: "var(--panel-text)" }}
          >
            {draft}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className="flex-1 rounded-lg py-2 text-xs font-semibold transition-all"
              style={
                copied
                  ? { background: "var(--semantic-success-bg)", color: "var(--semantic-success-text)", border: "1px solid var(--semantic-success-border)" }
                  : { background: "var(--panel-accent)", color: "var(--accent-text)", border: "1px solid transparent" }
              }
            >
              {copied ? "✓ Copied!" : "Copy to Clipboard"}
            </button>
            <button
              type="button"
              onClick={() => void generate()}
              disabled={loading}
              title="Regenerate"
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

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M5.433 13.917l1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z" />
      <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z" />
    </svg>
  );
}
