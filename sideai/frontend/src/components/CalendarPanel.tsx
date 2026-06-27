import { useEffect, useState } from "react";

const API = "http://127.0.0.1:8000";

interface CalEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendees: string[];
  location: string;
  meet_link: string;
  description: string;
}

async function apiFetch(path: string, options?: RequestInit) {
  const r = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

function formatTime(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso.slice(11, 16) || iso;
  }
}

export function CalendarPanel() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [briefs, setBriefs] = useState<Record<string, string>>({});
  const [briefLoading, setBriefLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");

  useEffect(() => { checkStatus(); }, []);

  async function checkStatus() {
    try {
      const d = await apiFetch("/api/calendar/status") as { connected: boolean };
      setConnected(d.connected);
      if (d.connected) loadEvents();
    } catch (_) { setConnected(false); }
  }

  async function loadEvents() {
    setLoading(true); setError("");
    try {
      const d = await apiFetch("/api/calendar/today") as { events: CalEvent[] };
      setEvents(d.events);
    } catch (e) {
      setError(`Could not load events: ${e}`);
    } finally { setLoading(false); }
  }

  async function connect() {
    try {
      const d = await apiFetch("/api/calendar/auth-url") as { url: string };
      // Open in system browser; Electron will handle the redirect
      if (typeof window !== "undefined" && (window as any).sideai?.openExternal) {
        (window as any).sideai.openExternal(d.url);
      } else {
        window.open(d.url, "_blank");
      }
      // Poll for the pending code every 2s for up to 60s
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        if (attempts > 30) { clearInterval(poll); return; }
        try {
          const r = await apiFetch("/api/calendar/pending-code") as { code: string | null };
          if (r.code) {
            clearInterval(poll);
            await apiFetch("/api/calendar/callback", { method: "POST", body: JSON.stringify({ code: r.code }) });
            setConnected(true);
            loadEvents();
          }
        } catch (_) {}
      }, 2000);
    } catch (e) {
      setError(`${e}`);
    }
  }

  async function disconnect() {
    await apiFetch("/api/calendar/disconnect", { method: "DELETE" });
    setConnected(false);
    setEvents([]);
  }

  async function getBrief(event: CalEvent) {
    setBriefLoading((prev) => ({ ...prev, [event.id]: true }));
    try {
      const d = await apiFetch("/api/calendar/brief", {
        method: "POST",
        body: JSON.stringify({ event }),
      }) as { brief: string };
      setBriefs((prev) => ({ ...prev, [event.id]: d.brief }));
    } catch (_) {}
    finally { setBriefLoading((prev) => ({ ...prev, [event.id]: false })); }
  }

  if (connected === null) return <p className="text-xs text-white/30">Checking…</p>;

  if (!connected) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[11px] text-white/50 leading-snug">
          Connect Google Calendar to see today's schedule and get AI meeting briefs.
        </p>
        <p className="text-[10px] text-white/30 leading-snug">
          Requires <code className="bg-white/8 px-1 rounded">GOOGLE_CLIENT_ID</code> in backend/.env
        </p>
        <button
          onClick={() => void connect()}
          className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold py-2 rounded-xl transition-colors"
        >
          Connect Google Calendar
        </button>
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-white/70">Today's schedule</p>
        <div className="flex gap-2">
          <button onClick={loadEvents} className="text-[10px] text-white/30 hover:text-white/60">↻ Refresh</button>
          <button onClick={() => void disconnect()} className="text-[10px] text-white/25 hover:text-red-400">Disconnect</button>
        </div>
      </div>

      {error && <p className="text-[11px] text-red-400">{error}</p>}

      {loading ? (
        <p className="text-xs text-white/30">Loading events…</p>
      ) : events.length === 0 ? (
        <p className="text-xs text-white/30 italic">No events today.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {events.map((ev) => (
            <div key={ev.id} className="rounded-xl border border-white/8 bg-white/4 p-3 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-white/90 truncate">{ev.summary}</p>
                  <p className="text-[10px] text-white/40">
                    {formatTime(ev.start)}{ev.end ? ` – ${formatTime(ev.end)}` : ""}
                    {ev.attendees.length > 0 && ` · ${ev.attendees.length} attendee${ev.attendees.length !== 1 ? "s" : ""}`}
                  </p>
                  {ev.location && <p className="text-[10px] text-white/30 truncate">{ev.location}</p>}
                </div>
                {ev.meet_link && (
                  <a
                    href={ev.meet_link}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-[10px] bg-green-600/70 hover:bg-green-500/70 text-white px-2 py-1 rounded-lg"
                  >
                    Join
                  </a>
                )}
              </div>

              {briefs[ev.id] ? (
                <div className="bg-white/4 rounded-lg p-2">
                  <p className="text-[10px] text-white/60 whitespace-pre-wrap leading-snug">{briefs[ev.id]}</p>
                </div>
              ) : (
                <button
                  onClick={() => void getBrief(ev)}
                  disabled={briefLoading[ev.id]}
                  className="text-[10px] text-indigo-400 hover:text-indigo-300 disabled:opacity-50 text-left"
                >
                  {briefLoading[ev.id] ? "Generating brief…" : "✦ Get AI prep brief"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
