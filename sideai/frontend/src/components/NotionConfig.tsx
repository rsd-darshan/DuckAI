import { useEffect, useState } from "react";

const API = "http://127.0.0.1:8000";

async function apiFetch(path: string, options?: RequestInit) {
  const r = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

interface Database { id: string; title: string; }

export function NotionConfig() {
  const [configured, setConfigured] = useState(false);
  const [tokenPreview, setTokenPreview] = useState("");
  const [dbId, setDbId] = useState("");
  const [databases, setDatabases] = useState<Database[]>([]);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => { loadConfig(); }, []);

  async function loadConfig() {
    try {
      const d = await apiFetch("/api/notion/config") as { configured: boolean; database_id: string; token_preview: string };
      setConfigured(d.configured);
      setTokenPreview(d.token_preview);
      setDbId(d.database_id);
      if (d.configured) loadDatabases();
    } catch (_) {}
  }

  async function loadDatabases() {
    setLoadingDbs(true);
    try {
      const d = await apiFetch("/api/notion/databases") as { databases: Database[] };
      setDatabases(d.databases);
    } catch (_) {}
    finally { setLoadingDbs(false); }
  }

  async function save() {
    if (!token.trim()) return;
    setSaving(true); setStatus("");
    try {
      await apiFetch("/api/notion/config", {
        method: "POST",
        body: JSON.stringify({ token: token.trim(), database_id: dbId }),
      });
      setToken("");
      setStatus("Saved!");
      await loadConfig();
      setTimeout(() => setStatus(""), 2000);
    } catch (e) {
      setStatus(`Error: ${e}`);
    } finally { setSaving(false); }
  }

  async function disconnect() {
    await apiFetch("/api/notion/config", { method: "DELETE" });
    setConfigured(false); setTokenPreview(""); setDbId(""); setDatabases([]);
  }

  return (
    <div className="flex flex-col gap-3">
      {configured ? (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
              <span className="text-xs text-white/70">Connected ({tokenPreview})</span>
            </div>
            <button onClick={() => void disconnect()} className="text-[10px] text-white/25 hover:text-red-400">
              Disconnect
            </button>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-white/40">Save to database</label>
            {loadingDbs ? (
              <p className="text-xs text-white/30">Loading databases…</p>
            ) : (
              <select
                value={dbId}
                onChange={async (e) => {
                  setDbId(e.target.value);
                  await apiFetch("/api/notion/config", {
                    method: "POST",
                    body: JSON.stringify({ token: "", database_id: e.target.value }),
                  });
                }}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="">Select a database…</option>
                {databases.map((db) => (
                  <option key={db.id} value={db.id}>{db.title}</option>
                ))}
              </select>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="text-[11px] text-white/50 leading-snug">
            Create a Notion integration at{" "}
            <span className="text-indigo-400">notion.so/my-integrations</span>, copy the token, and paste it here.
          </p>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            placeholder="secret_xxxxxxxxxxxxxxxx"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-white/20 focus:outline-none focus:border-indigo-500"
          />
          <button
            onClick={() => void save()}
            disabled={saving || !token.trim()}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold py-1.5 rounded-lg transition-colors"
          >
            {saving ? "Connecting…" : "Connect Notion"}
          </button>
          {status && <p className="text-[11px] text-white/50">{status}</p>}
        </>
      )}
    </div>
  );
}


/** Button to quickly save an AI answer to Notion — used inline in chat */
export function SaveToNotionButton({ title, content }: { title: string; content: string }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function save() {
    setState("saving");
    try {
      await apiFetch("/api/notion/save", {
        method: "POST",
        body: JSON.stringify({ title, content, source: "DuckAI Chat" }),
      });
      setState("saved");
      setTimeout(() => setState("idle"), 3000);
    } catch (_) {
      setState("error");
      setTimeout(() => setState("idle"), 2000);
    }
  }

  const labels = { idle: "Save to Notion", saving: "Saving…", saved: "Saved!", error: "Failed" };
  const colors = {
    idle: "text-white/30 hover:text-white/60 border-white/8 hover:border-white/20",
    saving: "text-white/30 border-white/8 opacity-50",
    saved: "text-emerald-400 border-emerald-500/30",
    error: "text-red-400 border-red-500/30",
  };

  return (
    <button
      onClick={() => void save()}
      disabled={state === "saving"}
      className={`text-[10px] px-2 py-1 rounded-lg border transition-colors ${colors[state]}`}
    >
      {labels[state]}
    </button>
  );
}
