import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  reply: string;
  error?: string;
}

function cfg() {
  return vscode.workspace.getConfiguration("sideai");
}

export function backendUrl(): string {
  return (cfg().get<string>("backendUrl") || "http://127.0.0.1:8000").replace(/\/$/, "");
}

function apiKey(): string {
  return cfg().get<string>("apiKey") || "";
}

function makeHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const k = apiKey();
  if (k) h["X-SideAI-Key"] = k;
  return h;
}

/** Simple fetch wrapper that works in the Node.js Extension Host (no browser fetch). */
export function apiFetch(path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const base = backendUrl();
    const url = new URL(path, base.endsWith("/") ? base : base + "/");
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const mod = url.protocol === "https:" ? https : http;

    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: payload ? "POST" : "GET",
        headers: {
          ...makeHeaders(),
          ...(payload ? { "Content-Length": payload.length } : {}),
        },
        timeout: 30000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            reject(new Error(`Non-JSON response (${res.statusCode})`));
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    if (payload) req.write(payload);
    req.end();
  });
}

export async function healthCheck(): Promise<boolean> {
  try {
    const r = await apiFetch("/health") as { status?: string };
    return r?.status === "ok" || typeof r === "object";
  } catch {
    return false;
  }
}

export async function chat(
  messages: ChatMessage[],
  context?: string
): Promise<ChatResponse> {
  try {
    const r = await apiFetch("/api/chat", {
      messages,
      screen_context: context ?? "",
      use_screen_context: !!context,
    }) as { reply?: string; error?: string };
    return { reply: r?.reply ?? "", error: r?.error };
  } catch (e) {
    return { reply: "", error: String(e) };
  }
}

/** Stream chat response, calling onChunk for each token. */
export async function chatStream(
  messages: ChatMessage[],
  context: string,
  onChunk: (chunk: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const base = backendUrl();
    const url = new URL("/api/chat/stream", base.endsWith("/") ? base : base + "/");
    const payload = Buffer.from(JSON.stringify({
      messages,
      screen_context: context,
      use_screen_context: !!context,
    }));
    const mod = url.protocol === "https:" ? https : http;

    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: { ...makeHeaders(), "Content-Length": payload.length },
        timeout: 60000,
      },
      (res) => {
        res.on("data", (chunk: Buffer) => {
          const lines = chunk.toString().split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const token = parsed?.choices?.[0]?.delta?.content;
              if (token) onChunk(token);
            } catch { /* partial chunk — ignore */ }
          }
        });
        res.on("end", resolve);
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
