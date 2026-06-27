const API = "http://127.0.0.1:8000";

/** Force Electron + Python capture so email/summarize work while the panel is expanded. */
export async function triggerScreenCapture(): Promise<{
  electronOk: boolean;
  visibleTextLen: number;
}> {
  let electronOk = false;
  let visibleTextLen = 0;

  try {
    const cap = await window.sideai?.captureScreen?.();
    if (cap?.ok) {
      electronOk = true;
      visibleTextLen = Number(cap.visible_text_len) || 0;
    }
  } catch (_) {}

  try {
    await fetch(`${API}/api/capture_now`, { method: "POST" });
  } catch (_) {}

  if (visibleTextLen < 40) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const ctxRes = await fetch(`${API}/api/context`);
      if (ctxRes.ok) {
        const ctx = await ctxRes.json() as { visible_text?: string };
        visibleTextLen = (ctx.visible_text || "").trim().length;
      }
    } catch (_) {}
  }

  return { electronOk, visibleTextLen };
}
