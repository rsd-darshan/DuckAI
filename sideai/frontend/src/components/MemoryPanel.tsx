import { useEffect, useState } from "react";

interface MemoryFact { id: string; key: string; value: string; category: string; source: string; updated_at: string; }
interface PendingFact { id: string; key: string; value: string; category: string; created_at: string; }

const API = "http://127.0.0.1:8000";

async function apiFetch(path: string, options?: RequestInit) {
  const r = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

const CATEGORY_STYLE: Record<string, { bg: string; color: string }> = {
  personal:    { bg: "rgba(167,139,250,0.15)", color: "#A78BFA" },
  work:        { bg: "rgba(96,165,250,0.15)",  color: "#60A5FA" },
  tech:        { bg: "rgba(52,211,153,0.15)",  color: "#34D399" },
  preferences: { bg: "rgba(251,191,36,0.15)",  color: "#FBBF24" },
  tools:       { bg: "rgba(251,113,133,0.15)", color: "#FB7185" },
  general:     { bg: "rgba(113,113,122,0.15)", color: "#71717A" },
};

const CATEGORIES = Object.keys(CATEGORY_STYLE);

export function MemoryPanel() {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [pending, setPending] = useState<PendingFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newCat, setNewCat] = useState("general");
  const [adding, setAdding] = useState(false);

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [memData, pendData] = await Promise.all([
        apiFetch("/api/memory") as Promise<{ items: MemoryFact[] }>,
        apiFetch("/api/memory/pending") as Promise<{ items: PendingFact[] }>,
      ]);
      setFacts(memData.items);
      setPending(pendData.items);
    } catch (_) {} finally { setLoading(false); }
  }

  async function addFact() {
    if (!newKey.trim() || !newValue.trim()) return;
    setAdding(true);
    try {
      await apiFetch("/api/memory", { method: "POST", body: JSON.stringify({ key: newKey.trim(), value: newValue.trim(), category: newCat }) });
      setNewKey(""); setNewValue(""); setNewCat("general");
      await load();
    } catch (_) {} finally { setAdding(false); }
  }

  async function deleteFact(key: string) {
    try {
      await apiFetch(`/api/memory/${encodeURIComponent(key)}`, { method: "DELETE" });
      setFacts((prev) => prev.filter((f) => f.key !== key));
    } catch (_) {}
  }

  async function saveEdit(fact: MemoryFact) {
    if (!editValue.trim()) return;
    try {
      await apiFetch("/api/memory", { method: "POST", body: JSON.stringify({ key: fact.key, value: editValue.trim(), category: fact.category, source: fact.source }) });
      setFacts((prev) => prev.map((f) => f.id === fact.id ? { ...f, value: editValue.trim() } : f));
    } catch (_) {}
    setEditingId(null);
  }

  async function approvePending(p: PendingFact) {
    try {
      await apiFetch(`/api/memory/pending/${p.id}/approve`, { method: "POST" });
      setPending((prev) => prev.filter((x) => x.id !== p.id));
      await load();
    } catch (_) {}
  }

  async function dismissPending(p: PendingFact) {
    try {
      await apiFetch(`/api/memory/pending/${p.id}/dismiss`, { method: "POST" });
      setPending((prev) => prev.filter((x) => x.id !== p.id));
    } catch (_) {}
  }

  const inputStyle = { background: "var(--panel-bg)", border: "1px solid var(--panel-border)", color: "var(--panel-text)" };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px]" style={{ color: "var(--panel-muted)" }}>
        Facts remembered across sessions. Auto-learned memories need approval before saving.
      </p>

      {loading ? (
        <p className="text-xs" style={{ color: "var(--panel-muted)" }}>Loading…</p>
      ) : (
        <>
          {/* ── Pending approval ─────────────────────────────── */}
          {pending.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--panel-accent)" }}>
                AI suggested · needs approval
              </p>
              {pending.map((p) => {
                const style = CATEGORY_STYLE[p.category] ?? CATEGORY_STYLE.general;
                return (
                  <div key={p.id} className="flex items-start gap-2 rounded-xl px-3 py-2" style={{ background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.2)" }}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium" style={{ background: style.bg, color: style.color }}>{p.category}</span>
                        <span className="text-[9px]" style={{ color: "var(--panel-muted)" }}>auto-detected</span>
                      </div>
                      <p className="text-[11px] font-medium truncate" style={{ color: "var(--panel-text)" }}>{p.key}</p>
                      <p className="text-[11px] break-words" style={{ color: "var(--panel-text-muted)" }}>{p.value}</p>
                    </div>
                    <div className="flex flex-col gap-1 pt-0.5">
                      <button onClick={() => void approvePending(p)}
                        className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md transition-all"
                        style={{ background: "rgba(52,211,153,0.15)", color: "#34D399" }}>
                        Save
                      </button>
                      <button onClick={() => void dismissPending(p)}
                        className="text-[10px] px-1.5 py-0.5 rounded-md transition-all"
                        style={{ background: "transparent", color: "var(--panel-muted)" }}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Confirmed memories ───────────────────────────── */}
          {facts.length === 0 && pending.length === 0 ? (
            <p className="text-xs italic" style={{ color: "var(--panel-muted)" }}>No memories yet — they'll be suggested automatically as you chat.</p>
          ) : facts.length > 0 && (
            <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto">
              {facts.map((f) => {
                const style = CATEGORY_STYLE[f.category] ?? CATEGORY_STYLE.general;
                const isEditing = editingId === f.id;
                return (
                  <div key={f.id} className="flex items-start gap-2 rounded-xl px-3 py-2 group" style={{ background: "var(--panel-surface-hover)", border: "1px solid var(--panel-border)" }}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium" style={{ background: style.bg, color: style.color }}>{f.category}</span>
                        {f.source === "auto" && <span className="text-[9px]" style={{ color: "var(--panel-muted)" }}>auto</span>}
                      </div>
                      <p className="text-[11px] font-medium truncate" style={{ color: "var(--panel-text)" }}>{f.key}</p>
                      {isEditing ? (
                        <div className="flex gap-1 mt-1">
                          <input
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") void saveEdit(f); if (e.key === "Escape") setEditingId(null); }}
                            autoFocus
                            className="flex-1 rounded-md px-2 py-0.5 text-[11px] focus:outline-none"
                            style={inputStyle}
                          />
                          <button onClick={() => void saveEdit(f)} className="text-[10px] px-1.5 rounded-md font-semibold" style={{ background: "var(--panel-accent)", color: "#fff" }}>✓</button>
                          <button onClick={() => setEditingId(null)} className="text-[10px] px-1.5 rounded-md" style={{ background: "var(--panel-surface-hover)", color: "var(--panel-muted)" }}>✕</button>
                        </div>
                      ) : (
                        <p className="text-[11px] break-words" style={{ color: "var(--panel-text-muted)" }}>{f.value}</p>
                      )}
                    </div>
                    {!isEditing && (
                      <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
                        <button
                          onClick={() => { setEditingId(f.id); setEditValue(f.value); }}
                          className="text-[10px]"
                          style={{ color: "var(--panel-muted)" }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--panel-accent)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--panel-muted)"; }}
                          title="Edit"
                        >✎</button>
                        <button
                          onClick={() => void deleteFact(f.key)}
                          className="text-[10px]"
                          style={{ color: "var(--panel-muted)" }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = "#F87171"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--panel-muted)"; }}
                          title="Forget"
                        >✕</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── Add manually ─────────────────────────────────────── */}
      <div className="flex flex-col gap-2 pt-2" style={{ borderTop: "1px solid var(--panel-border)" }}>
        <p className="text-[11px] font-medium" style={{ color: "var(--panel-muted)" }}>Add manually</p>
        <div className="flex gap-2">
          <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="Key (e.g. company)"
            className="flex-1 rounded-lg px-2.5 py-1.5 text-xs placeholder:text-zinc-600 focus:outline-none"
            style={{ ...inputStyle, transition: "border-color 150ms" }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--panel-accent)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--panel-border)"; }}
          />
          <select value={newCat} onChange={(e) => setNewCat(e.target.value)}
            className="rounded-lg px-2 py-1.5 text-xs focus:outline-none"
            style={inputStyle}
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <input value={newValue} onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void addFact()}
            placeholder="Value (e.g. Acme Corp)"
            className="flex-1 rounded-lg px-2.5 py-1.5 text-xs placeholder:text-zinc-600 focus:outline-none"
            style={{ ...inputStyle, transition: "border-color 150ms" }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--panel-accent)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--panel-border)"; }}
          />
          <button onClick={() => void addFact()} disabled={adding || !newKey.trim() || !newValue.trim()}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-40 transition-all"
            style={{ background: "var(--panel-accent)", color: "#fff" }}
          >
            {adding ? "…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
