import { useEffect, useState } from "react";
import { fetchContext, fetchSuggestions } from "./useBackend";

const POLL_INTERVAL_MS = 10_000; // 10s — suggestions don't need to be real-time

export interface ScreenContext {
  active_app: string;
  window_title: string;
  visible_text: string;
  task: string;
  ocr_confidence?: number;
  privacy_blocked?: boolean;
  context_limited_reason?: string | null;
  meeting_focus_active?: boolean;
  captured_at?: number;
  id?: string;
}

export function useContextPoll(enabled: boolean) {
  const [context, setContext] = useState<ScreenContext | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const [ctx, sug] = await Promise.all([
          fetchContext(),
          fetchSuggestions(),
        ]);
        if (!cancelled) {
          setContext(ctx);
          setSuggestions(sug.suggestions || []);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load context");
        }
      }
    };

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  return { context, suggestions, error };
}
