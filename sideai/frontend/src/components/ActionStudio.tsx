import { useEffect, useMemo, useRef, useState } from "react";
import {
  annotateImage,
  codeAnalyze,
  fetchFavoriteResponses,
  ingestKBDocument,
  listKBDocuments,
  queryKB,
  type SavedResponse,
  type KBDocument,
} from "../hooks/useBackend";

interface ActionStudioProps {
  onUseText: (text: string, sources?: Array<{ title: string; url: string; snippet: string }>) => void;
}

// ── Browser TTS (no backend call needed) ─────────────────────────────────────
function speakText(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text.trim());
  utt.rate = 1.0;
  utt.pitch = 1.0;
  window.speechSynthesis.speak(utt);
}

function stopSpeaking() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

export function ActionStudio({ onUseText }: ActionStudioProps) {
  const [favorites, setFavorites] = useState<SavedResponse[]>([]);
  const [favLoading, setFavLoading] = useState(false);

  const [kbQuery, setKbQuery] = useState("");
  const [kbAnswer, setKbAnswer] = useState("");
  const [kbSources, setKbSources] = useState<Array<{ title: string; chunk: string; score: number }>>([]);
  const [kbDocuments, setKbDocuments] = useState<KBDocument[]>([]);
  const [kbTitle, setKbTitle] = useState("");
  const [kbContent, setKbContent] = useState("");
  const [kbIngestLoading, setKbIngestLoading] = useState(false);
  const [kbQueryLoading, setKbQueryLoading] = useState(false);
  const [kbError, setKbError] = useState<string | null>(null);

  const [codeInput, setCodeInput] = useState("");
  const [codeLanguage, setCodeLanguage] = useState("typescript");
  const [codeReport, setCodeReport] = useState<{
    summary: { issue_count: number; high: number; medium: number; low: number };
    summary_text?: string;
    issues: Array<{ line: number | null; severity: string; type: string; message: string }>;
  } | null>(null);
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  const [annotatedPreview, setAnnotatedPreview] = useState<string | null>(null);
  const [annotationImage, setAnnotationImage] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [strokes, setStrokes] = useState<Array<{ points: Array<{ x: number; y: number }>; color?: string; width?: number }>>([]);
  const [annotLoading, setAnnotLoading] = useState(false);
  const [annotError, setAnnotError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [voiceText, setVoiceText] = useState("");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const ttsSupportedRef = useRef("speechSynthesis" in window);

  const hasCanvasAsset = useMemo(() => Boolean(annotationImage), [annotationImage]);

  const reloadFavorites = async () => {
    setFavLoading(true);
    try {
      const r = await fetchFavoriteResponses();
      setFavorites(r.items || []);
    } catch (_) {
    } finally {
      setFavLoading(false);
    }
  };

  useEffect(() => {
    reloadFavorites();
    listKBDocuments()
      .then((r) => setKbDocuments(r.items || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!annotationImage || !canvasRef.current) return;
    const img = new Image();
    img.src = annotationImage;
    img.onload = () => {
      imageRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
  }, [annotationImage]);

  // Track speech synthesis end
  useEffect(() => {
    if (!isSpeaking) return;
    const id = setInterval(() => {
      if (!window.speechSynthesis.speaking) setIsSpeaking(false);
    }, 300);
    return () => clearInterval(id);
  }, [isSpeaking]);

  const SEVERITY_COLOR: Record<string, string> = {
    high: "#F87171",
    medium: "#FBBF24",
    low: "#6B7280",
  };

  return (
    <section className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">

      {/* ── Saved Responses ─────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-panel-border bg-panel-surface p-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-panel-muted">Saved Responses</p>
          <button
            type="button"
            onClick={reloadFavorites}
            disabled={favLoading}
            className="text-[10px] px-2 py-1 rounded border border-panel-border text-panel-muted hover:text-slate-200 disabled:opacity-50"
          >
            {favLoading ? "Loading…" : "Refresh"}
          </button>
        </div>
        {favorites.length === 0 ? (
          <p className="text-[11px] text-panel-muted italic">No saved responses yet. Save any AI reply from the chat tab.</p>
        ) : (
          <div className="space-y-1.5 max-h-52 overflow-y-auto">
            {favorites.slice(0, 30).map((item) => (
              <div key={item.id} className="rounded border border-panel-border p-2 space-y-1">
                <p className="text-[11px] text-slate-200 whitespace-pre-wrap line-clamp-3">{item.content}</p>
                <button
                  type="button"
                  onClick={() => onUseText(item.content)}
                  className="text-[10px] px-2 py-1 rounded border border-panel-border text-panel-muted hover:text-slate-200"
                >
                  Use in chat
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Knowledge Base (RAG) ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-panel-border bg-panel-surface p-3 space-y-2">
        <p className="text-xs font-semibold text-panel-muted">Knowledge Base · {kbDocuments.length} doc{kbDocuments.length !== 1 ? "s" : ""}</p>
        {kbError && <p className="text-[11px] text-red-400">{kbError}</p>}
        <input
          value={kbTitle}
          onChange={(e) => setKbTitle(e.target.value)}
          placeholder="Document title"
          className="w-full rounded-lg border border-panel-border bg-panel-bg px-2.5 py-2 text-xs focus:outline-none focus:border-panel-accent"
        />
        <textarea
          value={kbContent}
          onChange={(e) => setKbContent(e.target.value)}
          placeholder="Paste source text to add to your knowledge base…"
          rows={4}
          className="w-full rounded-lg border border-panel-border bg-panel-bg px-2.5 py-2 text-xs resize-none focus:outline-none focus:border-panel-accent"
        />
        <button
          type="button"
          disabled={kbIngestLoading || !kbTitle.trim() || !kbContent.trim()}
          onClick={async () => {
            setKbError(null);
            setKbIngestLoading(true);
            try {
              await ingestKBDocument({ title: kbTitle.trim(), content: kbContent.trim() });
              setKbTitle("");
              setKbContent("");
              const next = await listKBDocuments();
              setKbDocuments(next.items || []);
            } catch (e) {
              setKbError(e instanceof Error ? e.message : "Failed to ingest document");
            } finally {
              setKbIngestLoading(false);
            }
          }}
          className="text-[11px] px-3 py-1.5 rounded border border-panel-border text-panel-muted hover:text-slate-200 disabled:opacity-50"
        >
          {kbIngestLoading ? "Ingesting…" : "Add to KB"}
        </button>
        <div className="flex gap-2">
          <input
            value={kbQuery}
            onChange={(e) => setKbQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") document.getElementById("kb-query-btn")?.click(); }}
            placeholder="Ask your knowledge base…"
            className="flex-1 rounded border border-panel-border bg-panel-bg px-2 py-1.5 text-xs focus:outline-none focus:border-panel-accent"
          />
          <button
            id="kb-query-btn"
            type="button"
            disabled={kbQueryLoading || !kbQuery.trim()}
            onClick={async () => {
              setKbError(null);
              setKbQueryLoading(true);
              setKbAnswer("");
              setKbSources([]);
              try {
                const res = await queryKB(kbQuery.trim(), 4);
                setKbAnswer(res.answer || "");
                setKbSources((res.sources || []).slice(0, 4));
              } catch (e) {
                setKbError(e instanceof Error ? e.message : "KB query failed");
              } finally {
                setKbQueryLoading(false);
              }
            }}
            className="text-[11px] px-3 py-1.5 rounded border border-panel-accent/60 text-panel-muted hover:text-slate-200 disabled:opacity-50"
          >
            {kbQueryLoading ? "Searching…" : "Ask"}
          </button>
        </div>
        {kbAnswer && (
          <div className="space-y-1">
            <p className="text-[11px] leading-snug text-slate-200 whitespace-pre-wrap">{kbAnswer}</p>
            {kbSources.length > 0 && (
              <div className="space-y-0.5">
                {kbSources.map((s, i) => (
                  <p key={i} className="text-[10px] text-panel-muted truncate">
                    [{i + 1}] {s.title} <span className="opacity-60">· score {s.score.toFixed(2)}</span>
                  </p>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => onUseText(kbAnswer)}
              className="text-[10px] px-2 py-0.5 rounded border border-panel-border text-panel-muted hover:text-slate-200"
            >
              Use in chat
            </button>
          </div>
        )}
      </div>

      {/* ── Code Analysis ────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-panel-border bg-panel-surface p-3 space-y-2">
        <p className="text-xs font-semibold text-panel-muted">Code Analysis</p>
        {codeError && <p className="text-[11px] text-red-400">{codeError}</p>}
        <div className="flex gap-2">
          <input
            value={codeLanguage}
            onChange={(e) => setCodeLanguage(e.target.value)}
            placeholder="language"
            className="w-28 rounded border border-panel-border bg-panel-bg px-2 py-1 text-xs focus:outline-none focus:border-panel-accent"
          />
          <p className="text-[10px] text-panel-muted self-center">e.g. typescript, python, go</p>
        </div>
        <textarea
          value={codeInput}
          onChange={(e) => setCodeInput(e.target.value)}
          placeholder="Paste code to analyze…"
          rows={5}
          className="w-full rounded border border-panel-border bg-panel-bg px-2.5 py-2 text-xs font-mono resize-none focus:outline-none focus:border-panel-accent"
        />
        <button
          type="button"
          disabled={codeLoading || !codeInput.trim()}
          onClick={async () => {
            setCodeError(null);
            setCodeReport(null);
            setCodeLoading(true);
            try {
              const report = await codeAnalyze(codeInput, codeLanguage);
              setCodeReport({ summary: report.summary, summary_text: report.summary_text, issues: report.issues });
            } catch (e) {
              setCodeError(e instanceof Error ? e.message : "Code analysis failed");
            } finally {
              setCodeLoading(false);
            }
          }}
          className="text-[11px] px-3 py-1.5 rounded border border-panel-border text-panel-muted hover:text-slate-200 disabled:opacity-50"
        >
          {codeLoading ? "Analyzing…" : "Analyze Code"}
        </button>
        {codeReport && (
          <div className="space-y-2">
            <div className="flex gap-3 text-[11px]">
              <span className="text-slate-200 font-medium">{codeReport.summary.issue_count} issues</span>
              {codeReport.summary.high > 0 && <span style={{ color: SEVERITY_COLOR.high }}>● {codeReport.summary.high} high</span>}
              {codeReport.summary.medium > 0 && <span style={{ color: SEVERITY_COLOR.medium }}>● {codeReport.summary.medium} medium</span>}
              {codeReport.summary.low > 0 && <span style={{ color: SEVERITY_COLOR.low }}>● {codeReport.summary.low} low</span>}
            </div>
            {codeReport.summary_text && (
              <p className="text-[11px] text-panel-muted leading-snug">{codeReport.summary_text}</p>
            )}
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {codeReport.issues.slice(0, 20).map((issue, idx) => (
                <div key={idx} className="flex gap-2 items-start text-[11px]">
                  <span className="shrink-0 font-mono" style={{ color: SEVERITY_COLOR[issue.severity] ?? "#6B7280" }}>
                    {issue.severity.toUpperCase()[0]}
                  </span>
                  <span className="text-slate-300">{issue.message}{issue.line ? ` (line ${issue.line})` : ""}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Screenshot Annotation ────────────────────────────────────────────── */}
      <div className="rounded-lg border border-panel-border bg-panel-surface p-3 space-y-2">
        <p className="text-xs font-semibold text-panel-muted">Screenshot Annotation</p>
        <p className="text-[10px] text-panel-muted">Upload an image, draw on it, then apply — the annotated result downloads back.</p>
        {annotError && <p className="text-[11px] text-red-400">{annotError}</p>}
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setAnnotError(null);
            setAnnotatedPreview(null);
            setStrokes([]);
            const reader = new FileReader();
            reader.onload = () => {
              const result = String(reader.result || "");
              const base64 = result.includes(",") ? result.split(",")[1] : result;
              setAnnotationImage(`data:image/png;base64,${base64}`);
            };
            reader.readAsDataURL(file);
          }}
          className="text-xs text-panel-muted"
        />
        {hasCanvasAsset && (
          <div className="space-y-2">
            <p className="text-[10px] text-panel-muted">Draw on image (red strokes). Click "Apply" to bake annotations in.</p>
            <canvas
              ref={canvasRef}
              className="w-full rounded border border-panel-border cursor-crosshair"
              onMouseDown={(e) => {
                const canvas = canvasRef.current;
                if (!canvas) return;
                const rect = canvas.getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
                const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
                setDrawing(true);
                setStrokes((prev) => [...prev, { points: [{ x, y }], color: "#ef4444", width: 3 }]);
              }}
              onMouseMove={(e) => {
                if (!drawing) return;
                const canvas = canvasRef.current;
                if (!canvas) return;
                const rect = canvas.getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
                const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
                setStrokes((prev) => {
                  if (prev.length === 0) return prev;
                  const next = [...prev];
                  const last = next[next.length - 1];
                  next[next.length - 1] = { ...last, points: [...last.points, { x, y }] };
                  const ctx = canvas.getContext("2d");
                  if (ctx) {
                    if (imageRef.current) ctx.drawImage(imageRef.current, 0, 0, canvas.width, canvas.height);
                    next.forEach((stroke) => {
                      if (stroke.points.length < 2) return;
                      ctx.strokeStyle = stroke.color || "#ef4444";
                      ctx.lineWidth = stroke.width || 3;
                      ctx.beginPath();
                      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
                      for (const p of stroke.points.slice(1)) ctx.lineTo(p.x, p.y);
                      ctx.stroke();
                    });
                  }
                  return next;
                });
              }}
              onMouseUp={() => setDrawing(false)}
              onMouseLeave={() => setDrawing(false)}
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={annotLoading || strokes.length === 0}
                onClick={async () => {
                  if (!annotationImage) return;
                  setAnnotError(null);
                  setAnnotLoading(true);
                  try {
                    const rawBase64 = annotationImage.split(",")[1] || "";
                    const out = await annotateImage(rawBase64, strokes);
                    setAnnotatedPreview(`data:image/png;base64,${out.image_base64}`);
                  } catch (e) {
                    setAnnotError(e instanceof Error ? e.message : "Annotation failed");
                  } finally {
                    setAnnotLoading(false);
                  }
                }}
                className="text-[11px] px-3 py-1.5 rounded border border-panel-border text-panel-muted hover:text-slate-200 disabled:opacity-50"
              >
                {annotLoading ? "Applying…" : "Apply Annotation"}
              </button>
              {strokes.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setStrokes([]);
                    const canvas = canvasRef.current;
                    if (canvas && imageRef.current) {
                      const ctx = canvas.getContext("2d");
                      ctx?.drawImage(imageRef.current, 0, 0, canvas.width, canvas.height);
                    }
                  }}
                  className="text-[11px] px-2 py-1.5 rounded border border-panel-border text-panel-muted hover:text-red-400"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
        {annotatedPreview && (
          <div className="space-y-1">
            <img src={annotatedPreview} alt="Annotated result" className="w-full rounded border border-panel-border" />
            <a
              href={annotatedPreview}
              download="annotated.png"
              className="inline-block text-[10px] px-2 py-1 rounded border border-panel-border text-panel-muted hover:text-slate-200"
            >
              Download
            </a>
          </div>
        )}
      </div>

      {/* ── Voice Text-to-Speech ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-panel-border bg-panel-surface p-3 space-y-2">
        <p className="text-xs font-semibold text-panel-muted">Text to Speech</p>
        {!ttsSupportedRef.current && (
          <p className="text-[11px] text-amber-400">Speech synthesis not supported in this browser.</p>
        )}
        <textarea
          value={voiceText}
          onChange={(e) => setVoiceText(e.target.value)}
          placeholder="Type or paste text to hear…"
          rows={3}
          className="w-full rounded border border-panel-border bg-panel-bg px-2.5 py-2 text-xs resize-none focus:outline-none focus:border-panel-accent"
          disabled={!ttsSupportedRef.current}
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!ttsSupportedRef.current || !voiceText.trim() || isSpeaking}
            onClick={() => {
              speakText(voiceText);
              setIsSpeaking(true);
            }}
            className="text-[11px] px-3 py-1.5 rounded border border-panel-border text-panel-muted hover:text-slate-200 disabled:opacity-50"
          >
            {isSpeaking ? "Speaking…" : "▶ Speak"}
          </button>
          {isSpeaking && (
            <button
              type="button"
              onClick={() => { stopSpeaking(); setIsSpeaking(false); }}
              className="text-[11px] px-3 py-1.5 rounded border border-panel-border text-red-400 hover:text-red-300"
            >
              ■ Stop
            </button>
          )}
        </div>
      </div>

    </section>
  );
}
