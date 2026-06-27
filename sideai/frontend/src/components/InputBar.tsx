import { useCallback, useEffect, useRef, useState } from "react";

const API = "http://127.0.0.1:8000";

async function apiFetch(path: string, options?: RequestInit) {
  return fetch(`${API}${path}`, options).catch(() => null);
}

interface InputBarProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (e: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string }; length: number }>; resultIndex?: number }) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

export function InputBar({ onSend, disabled }: InputBarProps) {
  const [value, setValue] = useState("");
  const [listening, setListening] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "loading" | "copied">("idle");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const hasCapturedRef = useRef(false);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    hasCapturedRef.current = false;
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setValue(next);
    if (next.length > 0 && !hasCapturedRef.current) {
      hasCapturedRef.current = true;
      apiFetch("/api/capture_now", { method: "POST" });
    }
    if (next.length === 0) hasCapturedRef.current = false;
  };

  const handleCopyContext = async () => {
    setCopyState("loading");
    try {
      const res = await apiFetch("/api/copy_context", { method: "POST" });
      const data = res ? await res.json() : null;
      await navigator.clipboard.writeText(data?.text ?? "Could not capture context.");
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 2200);
    } catch {
      setCopyState("idle");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSubmit(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const startVoice = useCallback(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR || disabled) return;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      if (last.isFinal) setValue((prev) => prev + last[0].transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }, [disabled]);

  const stopVoice = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  useEffect(() => {
    const fn = () => inputRef.current?.focus();
    window.addEventListener("sideai-focus-input", fn as EventListener);
    return () => window.removeEventListener("sideai-focus-input", fn as EventListener);
  }, []);

  const canSend = !disabled && value.trim().length > 0;

  return (
    <div
      className="shrink-0 px-3 pt-2 pb-3"
      style={{ background: "var(--panel-bg-elevated)", borderTop: "1px solid var(--panel-border)" }}
    >
      <div
        className="flex items-end gap-1 rounded-2xl p-1.5"
        style={{
          background: "var(--panel-surface)",
          border: "1px solid var(--panel-border)",
          boxShadow: "var(--panel-shadow-input)",
          transition: "border-color 150ms, box-shadow 150ms",
        }}
      >
        <textarea
          ref={inputRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything…"
          disabled={disabled}
          rows={1}
          style={{ color: "var(--panel-text)", background: "transparent" }}
          className="flex-1 min-h-[40px] max-h-32 resize-none rounded-xl px-2.5 py-2 text-sm placeholder:text-[color:var(--panel-muted)] focus:outline-none disabled:opacity-40"
          aria-label="Message input"
        />

        {/* Copy context icon */}
        <button
          type="button"
          onClick={() => void handleCopyContext()}
          disabled={copyState === "loading"}
          title="Copy screen context to clipboard"
          className="shrink-0 h-8 w-8 rounded-lg flex items-center justify-center transition-all disabled:opacity-40"
          style={{
            color: copyState === "copied" ? "var(--semantic-success-text)" : "var(--panel-muted)",
            background: copyState === "copied" ? "var(--semantic-success-bg)" : "transparent",
          }}
          onMouseEnter={(e) => {
            if (copyState !== "copied") (e.currentTarget as HTMLButtonElement).style.color = "var(--panel-text)";
          }}
          onMouseLeave={(e) => {
            if (copyState !== "copied") (e.currentTarget as HTMLButtonElement).style.color = "var(--panel-muted)";
          }}
        >
          {copyState === "copied" ? <CheckIcon /> : <ClipboardIcon />}
        </button>

        {/* Voice button */}
        <button
          type="button"
          onClick={listening ? stopVoice : startVoice}
          disabled={disabled}
          title={listening ? "Stop listening" : "Voice input (speech-to-text)"}
          className="shrink-0 h-8 w-8 rounded-lg flex items-center justify-center transition-all"
          style={{
            background: listening ? "var(--semantic-record-bg)" : "transparent",
            color: listening ? "var(--semantic-record-text)" : "var(--panel-muted)",
            border: listening ? "1px solid var(--semantic-record-border)" : "1px solid transparent",
          }}
        >
          {listening ? <StopIcon /> : <MicIcon />}
        </button>

        {/* Send button */}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSend}
          title="Send (↵ or ⌘↵)"
          className="shrink-0 h-8 w-8 rounded-xl flex items-center justify-center transition-all"
          style={{
            background: canSend ? "var(--panel-accent)" : "var(--panel-surface-hover)",
            color: canSend ? "var(--accent-text)" : "var(--panel-muted)",
            transform: "scale(1)",
          }}
          onMouseDown={(e) => { (e.currentTarget.style.transform = "scale(0.92)"); }}
          onMouseUp={(e) => { (e.currentTarget.style.transform = "scale(1)"); }}
          onMouseLeave={(e) => { (e.currentTarget.style.transform = "scale(1)"); }}
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
}

function SendIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden>
      <path d="M3.105 2.288a.75.75 0 0 0-.826.95l1.414 4.926A1.5 1.5 0 0 0 5.135 9.25h6.115a.75.75 0 0 1 0 1.5H5.135a1.5 1.5 0 0 0-1.442 1.086l-1.414 4.926a.75.75 0 0 0 .826.95 28.897 28.897 0 0 0 15.293-7.154.75.75 0 0 0 0-1.115A28.897 28.897 0 0 0 3.105 2.288Z" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden>
      <path d="M7 4a3 3 0 0 1 6 0v6a3 3 0 1 1-6 0V4Z" />
      <path d="M5.5 9.643a.75.75 0 0 0-1.5 0V10c0 3.06 2.29 5.585 5.25 5.954V17.5h-1.5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5H10.5v-1.546A6.001 6.001 0 0 0 15.5 10v-.357a.75.75 0 0 0-1.5 0V10a4.5 4.5 0 0 1-9 0v-.357Z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden>
      <path fillRule="evenodd" d="M2 10a8 8 0 1 1 16 0 8 8 0 0 1-16 0Zm5-2.25A.75.75 0 0 1 7.75 7h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-.75.75h-4.5a.75.75 0 0 1-.75-.75v-4.5Z" clipRule="evenodd" />
    </svg>
  );
}

function ClipboardIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3" aria-hidden>
      <path fillRule="evenodd" d="M5.75 0A1.75 1.75 0 0 0 4 1.75v.25H2.75A1.75 1.75 0 0 0 1 3.75v10.5C1 15.216 1.784 16 2.75 16h10.5A1.75 1.75 0 0 0 15 14.25V3.75A1.75 1.75 0 0 0 13.25 2H12v-.25A1.75 1.75 0 0 0 10.25 0h-4.5ZM6.5 2.75a.25.25 0 0 1 .25-.25h2.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-2.5a.25.25 0 0 1-.25-.25v-.5Z" clipRule="evenodd" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3" aria-hidden>
      <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clipRule="evenodd" />
    </svg>
  );
}
