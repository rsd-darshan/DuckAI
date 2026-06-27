import { fetchPermissionHealth } from "../hooks/useBackend";
import { guidanceFromContext, type CaptureGuidance } from "./captureGuidance";
import { triggerScreenCapture } from "./triggerScreenCapture";

const API = "http://127.0.0.1:8000";
const RESOLVE_TIMEOUT_MS = 12_000;
const CONTEXT_FETCH_TIMEOUT_MS = 5_000;

export type ReadableSource = "browser_js" | "screen_cache" | "ocr" | "none" | string;

export interface ResolvedReadable {
  text: string;
  source: ReadableSource;
  sufficient: boolean;
  needsChromeJs: boolean;
  emailContext: boolean;
  url: string | null;
  guidance: CaptureGuidance | null;
}

async function fetchLatestContext(): Promise<{
  visible_text?: string;
  window_title?: string;
  active_app?: string;
  context_limited_reason?: string | null;
}> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTEXT_FETCH_TIMEOUT_MS);
    const r = await fetch(`${API}/api/context`, { signal: controller.signal });
    clearTimeout(timer);
    if (r.ok) return await r.json();
  } catch (_) {}
  return {};
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll /api/context until visible_text exceeds `minLen` or we run out of attempts. */
async function pollForText(minLen: number, attempts = 5, intervalMs = 300): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const ctx = await fetchLatestContext();
    const text = (ctx.visible_text || "").trim();
    if (text.length >= minLen) return text;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return "";
}

export async function resolveReadableContent(opts: {
  screenText?: string;
  windowTitle?: string;
  activeApp?: string;
  purpose: "summarize" | "email_draft";
  forceFresh?: boolean;
  /** @deprecated Chrome DOM path removed. Param kept for compat; treated as forceFresh. */
  useBrowserDom?: boolean;
}): Promise<ResolvedReadable> {
  let screenText = opts.screenText ?? "";
  let windowTitle = opts.windowTitle ?? "";
  let activeApp = opts.activeApp ?? "";

  const needsCapture =
    opts.forceFresh || opts.useBrowserDom || screenText.trim().length < 55;

  if (needsCapture) {
    const cap = await triggerScreenCapture();

    // Poll with backoff until we get fresh text — avoids stale context from
    // the previous background loop tick overwriting a good on-demand capture.
    const minLen = cap.visibleTextLen > 0 ? Math.max(cap.visibleTextLen, 40) : 40;
    const polled = await pollForText(minLen, 5, 300);
    if (polled.length > screenText.trim().length) {
      screenText = polled;
    } else if (cap.visibleTextLen < 40) {
      // Last-ditch: one extra wait then a single fetch
      await sleep(500);
      const ctx = await fetchLatestContext();
      const ctxText = (ctx.visible_text || "").trim();
      if (ctxText.length > screenText.trim().length) {
        screenText = ctxText;
        windowTitle = ctx.window_title || windowTitle;
        activeApp = ctx.active_app || activeApp;
      }
    } else {
      const ctx = await fetchLatestContext();
      const ctxText = (ctx.visible_text || "").trim();
      if (ctxText.length > screenText.trim().length) {
        screenText = ctxText;
        windowTitle = ctx.window_title || windowTitle;
        activeApp = ctx.active_app || activeApp;
      }
    }
  }

  const body = {
    screen_text: screenText,
    window_title: windowTitle,
    active_app: activeApp,
    purpose: opts.purpose,
    force_fresh: Boolean(opts.forceFresh || opts.useBrowserDom),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

  try {
    const r = await fetch(`${API}/api/content/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (r.ok) {
      const d = await r.json() as {
        text?: string;
        source?: string;
        sufficient?: boolean;
        needs_chrome_js?: boolean;
        email_context?: boolean;
        url?: string | null;
        context_limited_reason?: string | null;
        min_chars?: number;
      };
      const text = (d.text || "").trim();
      const minChars = d.min_chars ?? (opts.purpose === "email_draft" ? 55 : 45);
      let guidance: CaptureGuidance | null = null;
      if (!d.sufficient) {
        const health = await fetchPermissionHealth().catch(() => null);
        guidance = guidanceFromContext(
          {
            visible_text: screenText,
            context_limited_reason: d.context_limited_reason ?? null,
          },
          health,
          { needsChromeJs: Boolean(d.needs_chrome_js), minChars }
        );
        if (guidance.kind === "none") {
          const titleHint = (windowTitle || "").trim();
          guidance = {
            kind: "empty",
            title: "Could not read screen content",
            message: titleHint
              ? `DuckAI sees "${titleHint.slice(0, 48)}…" but couldn't read the body. Make sure it's fully visible and try again.`
              : "Make sure the content is fully visible and try again.",
            bullets: [],
          };
        }
      }
      return {
        text,
        source: (d.source as ReadableSource) || "none",
        sufficient: Boolean(d.sufficient),
        needsChromeJs: Boolean(d.needs_chrome_js),
        emailContext: Boolean(d.email_context),
        url: d.url ?? null,
        guidance,
      };
    }
    // Non-OK HTTP response
    clearTimeout(timer);
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof Error && e.name === "AbortError") {
      return {
        text: screenText.trim(),
        source: screenText.trim().length >= 55 ? "screen_cache" : "none",
        sufficient: screenText.trim().length >= 55,
        needsChromeJs: false,
        emailContext: false,
        url: null,
        guidance: {
          kind: "empty",
          title: "Reading timed out",
          message: "Make sure the content is fully visible and try again.",
          bullets: [],
        },
      };
    }
  }

  // Fallback: return whatever screen text we have
  const fallback = screenText.trim();
  return {
    text: fallback,
    source: "screen_cache",
    sufficient: fallback.length >= 55,
    needsChromeJs: false,
    emailContext: false,
    url: null,
    guidance: null,
  };
}
