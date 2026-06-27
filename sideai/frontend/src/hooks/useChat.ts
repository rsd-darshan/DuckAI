import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatResponseMetadata } from "./useBackend";
import {
  addConversationMessage,
  captureNow,
  createConversation,
  fetchContext,
  sendChat,
  sendChatStream,
  setConversationMemoryMode,
  synthesizeAnswer,
  typeText,
} from "./useBackend";

/** DuckDuckGo-style hit passed to the chat UI as “Sources”. */
export type WebSearchHit = { title: string; url: string; snippet: string };

export type SendOptions = {
  /** When using `/search` or `/web`, populated with result links for the Sources strip. */
  onWebHits?: (hits: WebSearchHit[]) => void;
};

const STORAGE_KEY = "sideai_chat";
const OFFLINE_QUEUE_KEY = "sideai_offline_queue";
const SCREEN_CTX_BY_CONV_KEY = "sideai_use_screen_context_by_conversation";

function loadScreenContextMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SCREEN_CTX_BY_CONV_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== "object" || Array.isArray(p)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function screenContextStorageKey(conversationId: string | null): string {
  return conversationId ?? "_new";
}

function newClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

interface QueuedItem {
  id: string;
  messages: ChatMessage[];
  context: Record<string, unknown> | null;
}

function isLikelyOfflineError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network error") ||
    message.includes("ecconnrefused") ||
    message.includes("load failed")
  );
}

function isComposeCommand(content: string): boolean {
  const lower = content.trim().toLowerCase();
  if (/^text\s/.test(lower)) return true;
  if (/^send\s/.test(lower)) return true;
  if (/^reply\s+with\s/.test(lower)) return true;
  if (/^write\s/.test(lower)) return true;
  if (/^tell\s+.+\s+to\s/.test(lower)) return true;
  if (/^say\s/.test(lower)) return true;
  if (/^(message|msg)\s+(him|her|them|this\s+guy)\s*:?\s*/i.test(lower)) return true;
  return false;
}

function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ChatMessage[];
      if (!Array.isArray(parsed)) return [];
      let changed = false;
      const next = parsed.map((m) => {
        if (m.id) return m;
        changed = true;
        return { ...m, id: newClientMessageId() };
      });
      if (changed) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch (_) {}
      }
      return next;
    }
  } catch (_) {}
  return [];
}

function loadQueue(): QueuedItem[] {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as QueuedItem[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (_) {}
  return [];
}

export function useChat(context: Record<string, unknown> | null, backendReady: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>(loadMessages);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offlineQueue, setOfflineQueue] = useState<QueuedItem[]>(loadQueue);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [lastUserPrompt, setLastUserPrompt] = useState<string | null>(null);
  const [memoryMode, setMemoryMode] = useState<"this_chat_only" | "remember_24h" | "never_remember">("this_chat_only");
  const [useScreenContext, setUseScreenContextState] = useState(true);
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const map = loadScreenContextMap();
      if (conversationId && map[conversationId] === undefined && typeof map._new === "boolean") {
        map[conversationId] = map._new;
        localStorage.setItem(SCREEN_CTX_BY_CONV_KEY, JSON.stringify(map));
      }
      const key = screenContextStorageKey(conversationId);
      if (typeof map[key] === "boolean") setUseScreenContextState(map[key]!);
      else setUseScreenContextState(true);
    } catch {
      setUseScreenContextState(true);
    }
  }, [conversationId]);

  const setUseScreenContext = useCallback((value: boolean) => {
    setUseScreenContextState(value);
    try {
      const map = loadScreenContextMap();
      map[screenContextStorageKey(conversationId)] = value;
      localStorage.setItem(SCREEN_CTX_BY_CONV_KEY, JSON.stringify(map));
    } catch {
      /* ignore */
    }
  }, [conversationId]);

  useEffect(() => {
    if (memoryMode === "never_remember") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch (_) {}
  }, [messages, memoryMode]);

  useEffect(() => {
    if (memoryMode !== "never_remember") return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }, [memoryMode]);

  useEffect(() => {
    try {
      localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(offlineQueue));
    } catch (_) {}
  }, [offlineQueue]);

  const queueRequest = useCallback((item: QueuedItem) => {
    setOfflineQueue((prev) => [...prev, item]);
  }, []);

  const ensureConversation = useCallback(
    async (titleSeed: string, appContext: string) => {
      if (memoryMode !== "remember_24h") return null;
      if (conversationId) return conversationId;
      const created = await createConversation({
        title: titleSeed.slice(0, 64),
        tags: [],
        app_context: appContext,
        memory_mode: memoryMode,
      });
      setConversationId(created.id);
      return created.id;
    },
    [conversationId, memoryMode]
  );

  const runStreamReply = useCallback(
    async (
      nextMessages: ChatMessage[],
      effectiveContext: Record<string, unknown> | null,
      activeConversationId: string | null,
      onFinalMeta?: (meta: ChatResponseMetadata) => void
    ) => {
      let streamed = "";
      const abortController = new AbortController();
      streamAbortRef.current = abortController;
      setMessages((prev) => [...prev, { role: "assistant", content: "", id: newClientMessageId() }]);
      try {
        await sendChatStream(
          nextMessages,
          effectiveContext,
          (chunk) => {
            streamed += chunk;
            setMessages((prev) => {
              if (prev.length === 0) return prev;
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "assistant") {
                next[next.length - 1] = { ...last, role: "assistant", content: streamed };
              }
              return next;
            });
          },
          activeConversationId,
          abortController.signal,
          { memoryMode, useScreenContext },
          onFinalMeta
        );
      } finally {
        streamAbortRef.current = null;
      }
      return streamed.trim();
    },
    [memoryMode, useScreenContext]
  );

  const send = useCallback(
    async (
      content: string,
      overrideContext?: Record<string, unknown> | null,
      options?: SendOptions | null
    ) => {
      if (!content.trim()) return;
      const trimmed = content.trim();
      const webMatch = trimmed.match(/^\/(search|web)\s+(.+)$/i);
      if (webMatch) {
        const query = webMatch[2].trim();
        if (!query) return;
        const userMsg: ChatMessage = { role: "user", content: trimmed, id: newClientMessageId() };
        setMessages((prev) => [...prev, userMsg]);
        setLoading(true);
        setError(null);
        try {
          const effectiveContext: Record<string, unknown> | null = overrideContext ?? context;
          const convId = await ensureConversation(
            `Search: ${query.slice(0, 48)}`,
            String((effectiveContext?.active_app as string | undefined) || "")
          );
          // Web synthesis must not receive screen context — avoids "I can't see your screen" / wrong grounding.
          const { answer, hits, synthesis_error } = await synthesizeAnswer(query, null, { limit: 8 });
          const replyTrimmed = (answer || "").trim();
          let assistantOut = replyTrimmed;
          if (!assistantOut && (hits?.length ?? 0) > 0) {
            assistantOut = synthesis_error?.trim()
              ? `No AI summary: ${synthesis_error.trim()} — open the Sources strip for links.`
              : "No AI summary; open the Sources strip for links.";
          } else if (!assistantOut) {
            assistantOut = synthesis_error?.trim() || "Web search returned no results.";
          }
          // Red banner only when there’s nothing to show in Sources
          setError((hits?.length ?? 0) === 0 && synthesis_error?.trim() ? synthesis_error.trim() : null);
          setMessages((prev) => [...prev, { role: "assistant", content: assistantOut, id: newClientMessageId() }]);
          options?.onWebHits?.(hits || []);
          if (convId) {
            await addConversationMessage(convId, "user", userMsg.content);
            await addConversationMessage(convId, "assistant", assistantOut);
          }
        } catch (e) {
          const errMessage = e instanceof Error ? e.message : "Web search failed";
          setError(errMessage);
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `Web search failed: ${errMessage}`, id: newClientMessageId() },
          ]);
        } finally {
          setLoading(false);
        }
        return;
      }

      const userMsg: ChatMessage = { role: "user", content: trimmed, id: newClientMessageId() };
      setLastUserPrompt(trimmed);
      setMessages((prev) => [...prev, userMsg]);
      setLoading(true);
      setError(null);
      const shouldAutoType = isComposeCommand(trimmed);
      try {
        const nextMessages = [...messages, userMsg];
        // Always fetch the freshest context from the backend before sending —
        // avoids using 10s-stale React state when the user recently switched apps.
        let effectiveContext: Record<string, unknown> | null = overrideContext ?? context;
        try {
          effectiveContext = await fetchContext();
        } catch {
          // fall back to the polled context already in state
        }
        const lower = trimmed.toLowerCase();
        const isScreenQuestion =
          lower.includes("on my screen") ||
          lower.includes("what am i looking at") ||
          lower.includes("where am i") ||
          lower.includes("what do you see") ||
          lower.includes("what am i watching") ||
          lower.includes("what video") ||
          lower.includes("this video") ||
          lower.includes("this song") ||
          lower.includes("what song") ||
          lower.includes("describe this") ||
          lower.includes("what's on my screen") ||
          lower.includes("what is on my screen");
        if (isScreenQuestion) {
          try {
            await captureNow();
            effectiveContext = await fetchContext();
          } catch {
            // fall back to context already fetched above
          }
        }
        const convId = await ensureConversation(
          trimmed,
          String((effectiveContext?.active_app as string | undefined) || "")
        );
        let finalMeta: ChatResponseMetadata | undefined;
        let replyTrimmed = await runStreamReply(nextMessages, effectiveContext, convId, (meta) => {
          finalMeta = meta;
        });
        if (!replyTrimmed) {
          const fallback = await sendChat(nextMessages, effectiveContext, convId, {
            memoryMode,
            useScreenContext,
          });
          replyTrimmed = (fallback.content || "").trim();
          if (!replyTrimmed) throw new Error("Assistant returned an empty response");
          finalMeta = {
            context_receipt_v2: fallback.context_receipt_v2 ?? null,
            confidence: fallback.confidence ?? null,
            verification: fallback.verification ?? null,
            smart_followups: fallback.smart_followups ?? [],
            memory_mode: memoryMode,
          };
          setMessages((prev) => {
            if (prev.length === 0) return [...prev, { role: "assistant", content: replyTrimmed, id: newClientMessageId() }];
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant" && !last.content.trim()) {
              next[next.length - 1] = { ...last, role: "assistant", content: replyTrimmed, meta: finalMeta };
              return next;
            }
            return [...next, { role: "assistant", content: replyTrimmed, id: newClientMessageId(), meta: finalMeta }];
          });
        } else if (finalMeta) {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { ...last, meta: finalMeta };
            }
            return next;
          });
        }
        if (convId) {
          await setConversationMemoryMode(convId, memoryMode).catch(() => {});
          await addConversationMessage(convId, "user", userMsg.content);
          await addConversationMessage(convId, "assistant", replyTrimmed);
        }
        if (shouldAutoType && replyTrimmed) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `Typing: "${replyTrimmed.slice(0, 40)}${replyTrimmed.length > 40 ? "…" : ""}"`,
              id: newClientMessageId(),
            },
          ]);
          typeText(replyTrimmed, { method: "type", delaySeconds: 1.5 }).catch(() => {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.content.startsWith("Typing:")) {
                return [...prev.slice(0, -1), { role: "assistant" as const, content: replyTrimmed, id: last.id }];
              }
              return prev;
            });
          });
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          setError("Generation stopped.");
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant" && !last.content.trim()) {
              next[next.length - 1] = { ...last, role: "assistant", content: "Stopped." };
            }
            return next;
          });
          return;
        }
        const errMessage = e instanceof Error ? e.message : "Send failed";
        setError(errMessage);
        if (isLikelyOfflineError(e)) {
          queueRequest({
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            messages: [...messages, userMsg],
            context: overrideContext ?? context,
          });
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: "Offline detected. Your request is queued and will retry automatically.",
              id: newClientMessageId(),
            },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `Request failed: ${errMessage}`,
              id: newClientMessageId(),
            },
          ]);
        }
      } finally {
        setLoading(false);
      }
    },
    [messages, context, queueRequest, runStreamReply, ensureConversation, useScreenContext]
  );

  const dismissOfflineQueue = useCallback(() => {
    setOfflineQueue([]);
  }, []);

  const retryQueued = useCallback(async () => {
    if (!backendReady || loading || offlineQueue.length === 0) return;
    setLoading(true);
    try {
      const [next, ...rest] = offlineQueue;
      const lastUser = [...next.messages].reverse().find((m) => m.role === "user");
      const titleSeed = (lastUser?.content || "Offline retry").slice(0, 64);
      const appCtx = String((next.context?.active_app as string | undefined) || "");
      const convId = await ensureConversation(titleSeed, appCtx);
      let replyTrimmed = await runStreamReply(next.messages, next.context, convId, undefined);
      if (!replyTrimmed) {
        const fallback = await sendChat(next.messages, next.context, convId, {
          memoryMode,
          useScreenContext,
        });
        replyTrimmed = (fallback.content || "").trim();
        if (!replyTrimmed) throw new Error("Assistant returned an empty response");
        setMessages((prev) => {
          if (prev.length === 0) return [...prev, { role: "assistant", content: replyTrimmed, id: newClientMessageId() }];
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant" && !last.content.trim()) {
            copy[copy.length - 1] = { ...last, role: "assistant", content: replyTrimmed };
            return copy;
          }
          return [...copy, { role: "assistant", content: replyTrimmed, id: newClientMessageId() }];
        });
      }
      if (lastUser?.content && replyTrimmed && convId) {
        await addConversationMessage(convId, "user", lastUser.content);
        await addConversationMessage(convId, "assistant", replyTrimmed);
      }
      setOfflineQueue(rest);
    } catch {
      // keep queue; backend may still be unstable
    } finally {
      setLoading(false);
    }
  }, [backendReady, loading, offlineQueue, runStreamReply, ensureConversation, memoryMode, useScreenContext]);

  useEffect(() => {
    if (!backendReady) return;
    const id = setInterval(() => {
      retryQueued().catch(() => {});
    }, 4000);
    return () => clearInterval(id);
  }, [backendReady, retryQueued]);

  const clear = useCallback(() => {
    streamAbortRef.current?.abort();
    setMessages([]);
    setError(null);
    setConversationId(null);
  }, []);

  const stop = useCallback(() => {
    streamAbortRef.current?.abort();
  }, []);

  const retryLast = useCallback(() => {
    if (!lastUserPrompt || loading) return;
    setError(null);
    send(lastUserPrompt).catch(() => {});
  }, [lastUserPrompt, loading, send]);

  const loadConversationMessages = useCallback((nextMessages: ChatMessage[], nextConversationId: string | null) => {
    setMessages(nextMessages);
    setConversationId(nextConversationId);
    setError(null);
  }, []);

  return {
    messages,
    loading,
    error,
    send,
    clear,
    offlineQueueSize: offlineQueue.length,
    retryQueued,
    dismissOfflineQueue,
    conversationId,
    setConversationId,
    memoryMode,
    setMemoryMode,
    useScreenContext,
    setUseScreenContext,
    loadConversationMessages,
    stop,
    retryLast,
  };
}
