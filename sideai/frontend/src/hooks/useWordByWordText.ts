import { useEffect, useRef, useState } from "react";

const DEFAULT_MS_PER_TOKEN = 44;

/** Words plus whitespace chunks so spacing matches the original string. */
export function splitRevealTokens(text: string): string[] {
  if (!text) return [];
  return text.match(/\S+|\s+/g) ?? [];
}

export interface UseWordByWordTextOptions {
  /** While true, reveal toward `fullText` one token at a time. When false, show all of `fullText` immediately. */
  active: boolean;
  msPerToken?: number;
}

export interface WordByWordTextResult {
  displayText: string;
  /** Plain text while catching up; switch to full markdown when false. */
  usePlainText: boolean;
}

export function useWordByWordText(
  fullText: string,
  { active, msPerToken = DEFAULT_MS_PER_TOKEN }: UseWordByWordTextOptions
): WordByWordTextResult {
  const fullTextRef = useRef(fullText);
  fullTextRef.current = fullText;

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const [count, setCount] = useState(0);
  const prevFullRef = useRef(fullText);

  useEffect(() => {
    const prev = prevFullRef.current;
    if (fullText === "") {
      setCount(0);
    } else if (prev !== "" && !fullText.startsWith(prev)) {
      setCount(0);
    }
    prevFullRef.current = fullText;
  }, [fullText]);

  const tokens = splitRevealTokens(fullText);
  const total = tokens.length;

  useEffect(() => {
    if (reduceMotion || !active) {
      setCount(total);
      return;
    }
    if (count >= total) return;
    const id = window.setTimeout(() => {
      const t = splitRevealTokens(fullTextRef.current);
      setCount((c) => Math.min(c + 1, t.length));
    }, msPerToken);
    return () => window.clearTimeout(id);
  }, [active, total, reduceMotion, msPerToken, count]);

  const displayText = tokens.slice(0, Math.min(count, total)).join("");
  const usePlainText = Boolean(active && !reduceMotion && count < total);

  return { displayText: usePlainText ? displayText : fullText, usePlainText };
}
