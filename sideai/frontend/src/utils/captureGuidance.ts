import type { PermissionHealth } from "../hooks/useBackend";

export type CaptureGuidanceKind =
  | "privacy"
  | "paused"
  | "ocr_empty"
  | "permission"
  | "empty"
  | "none";

export interface CaptureGuidance {
  kind: CaptureGuidanceKind;
  title: string;
  message: string;
  bullets?: string[];
}

export function guidanceFromContext(
  context: {
    visible_text?: string;
    context_limited_reason?: string | null;
  } | null,
  health: PermissionHealth | null,
  opts?: { needsChromeJs?: boolean; minChars?: number }
): CaptureGuidance {
  const minChars = opts?.minChars ?? 80;
  const text = (context?.visible_text || "").trim();
  if (text.length >= minChars) {
    return { kind: "none", title: "", message: "" };
  }
  const limited = context?.context_limited_reason;
  if (limited === "blocklist" || limited === "meeting_focus" || limited === "allowlist") {
    return {
      kind: "privacy",
      title: "Content hidden by privacy settings",
      message: "Privacy settings are limiting what DuckAI can see. Adjust in Settings → Privacy.",
    };
  }
  const screen = health?.screen_recording;
  if (screen?.blocked_reason === "paused") {
    return {
      kind: "paused",
      title: "Reading paused",
      message: "DuckAI is not reading your screen right now.",
    };
  }
  if (screen?.ok) {
    return {
      kind: "empty",
      title: "Not enough text visible",
      message: "Open the full content and make sure it is visible, then try again.",
    };
  }
  if (screen?.blocked_reason === "ocr_empty") {
    return {
      kind: "ocr_empty",
      title: "Could not read content",
      message: "DuckAI couldn't read the visible content. Make sure it's fully loaded and try again.",
    };
  }
  return {
    kind: "permission",
    title: "Reading not available",
    message: "DuckAI needs permission to read your screen. Please enable it in System Settings and relaunch.",
  };
}
