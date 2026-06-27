const {
  app,
  BrowserWindow,
  screen,
  ipcMain,
  globalShortcut,
  Tray,
  nativeImage,
  Menu,
  clipboard,
  Notification,
  shell,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

// Suppress FIDO/caBLE terminal noise when launched from Terminal
try { app.commandLine.appendSwitch("disable-features", "WebAuthenticationCable"); } catch (_) {}

const BACKEND_PORT = 8000;
const HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/health`;
const NOTIFICATION_TOAST_MAX_AGE_MS = 10 * 60 * 1000;

if (process.platform === "win32") {
  try { app.setAppUserModelId("com.sideai.sideai"); } catch (_) {}
}

const PANEL_WIDTH = 320;
const STRIP_WIDTH = 48;

let mainWindow = null;
let pythonProcess = null;
let panelCollapsed = false;
let tray = null;
let clipboardPollTimer = null;
let lastClipboardText = "";
let registeredDynamicHotkeys = [];
let hotkeyRefreshTimer = null;
let sidebarPosition = "right";
let notificationPollTimer = null;
let seenNotificationIds = new Set();

// ─── Path resolution: dev vs packaged ───────────────────────────────────────
const isPacked = app.isPackaged;
// In packaged app: resources/ lives at process.resourcesPath
// In dev: the monorepo root is one level above electron/
const rootDir = isPacked ? process.resourcesPath : path.join(__dirname, "..");
const frontendDist = isPacked
  ? path.join(process.resourcesPath, "frontend", "dist")
  : path.join(rootDir, "frontend", "dist");
// Backend: either the bundled PyInstaller executable or the dev venv
const backendDir = isPacked
  ? path.join(process.resourcesPath, "backend")
  : path.join(rootDir, "backend");
const bundledExecutable = path.join(
  backendDir,
  process.platform === "win32" ? "sideai-backend.exe" : "sideai-backend"
);

// ─── Auto-updater (production only) ─────────────────────────────────────────
if (isPacked) {
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.logger = require("electron").nativeTheme; // silence in prod; swap for a real logger
    autoUpdater.checkForUpdatesAndNotify();
    autoUpdater.on("update-downloaded", () => {
      dialog.showMessageBox({
        type: "info",
        title: "Update ready",
        message: "A new version of DuckAI has been downloaded. Restart to apply.",
        buttons: ["Restart now", "Later"],
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
    });
  } catch (_) {}
}

// ─── First-run / onboarding marker ───────────────────────────────────────────
const ONBOARDING_MARKER = path.join(backendDir, ".sideai_onboarded");

function isFirstRun() {
  if (fs.existsSync(ONBOARDING_MARKER)) return false;
  const dbPath = path.join(backendDir, "sideai.db");
  return !fs.existsSync(dbPath);
}

// ─── Python / backend launch ─────────────────────────────────────────────────
function getManagedEnv() {
  // Managed API key is injected at build time via SIDEAI_MANAGED_GROQ_KEY env var.
  // It never lives in the repository — set it in your CI secrets or local build env.
  const managedGroqKey = process.env.SIDEAI_MANAGED_GROQ_KEY || "";
  const managedHfToken = process.env.SIDEAI_MANAGED_HF_TOKEN || "";
  return { managedGroqKey, managedHfToken };
}

function getPythonCommand() {
  const uvicornArgs = ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)];

  // 1. Packaged: use the bundled PyInstaller executable
  if (isPacked && fs.existsSync(bundledExecutable)) {
    return { exe: bundledExecutable, args: [] };
  }

  // 2. Dev: prefer venv python — path differs on Windows vs Unix
  const venvBin = process.platform === "win32"
    ? path.join(backendDir, "venv", "Scripts", "python.exe")
    : path.join(backendDir, "venv", "bin", "python");
  if (fs.existsSync(venvBin)) {
    return { exe: venvBin, args: uvicornArgs };
  }

  // 3. Fallback: system python
  const systemPy = process.platform === "win32" ? "python" : "python3";
  return { exe: systemPy, args: uvicornArgs };
}

function safeWriteToStream(stream, chunk) {
  try {
    if (!stream || stream.destroyed || !stream.writable) return;
    stream.write(chunk);
  } catch (err) {
    if (err && (err.code === "EIO" || err.code === "EPIPE")) return;
    throw err;
  }
}

process.on("uncaughtException", (err) => {
  if (err && (err.code === "EIO" || err.code === "EPIPE")) return;
  throw err;
});

function startBackend() {
  return new Promise((resolve, reject) => {
    const { exe, args } = getPythonCommand();
    const { managedGroqKey, managedHfToken } = getManagedEnv();

    // Locate Tesseract: bundled binary takes priority over system install
    const bundledTesseract = path.join(
      isPacked ? process.resourcesPath : path.join(rootDir, "assets"),
      "tesseract",
      "tesseract"
    );
    const tesseractCmd = fs.existsSync(bundledTesseract) ? bundledTesseract : "tesseract";

    const spawnEnv = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      // Pass managed keys so the backend can use them when no user key is configured
      SIDEAI_MANAGED_GROQ_KEY: managedGroqKey,
      SIDEAI_MANAGED_HF_TOKEN: managedHfToken,
      // Tell pytesseract where to find the Tesseract binary
      TESSDATA_PREFIX: path.dirname(tesseractCmd),
      SIDEAI_TESSERACT_CMD: tesseractCmd,
      // Use backend dir as cwd so relative paths (sideai.db, .env) resolve correctly
      SIDEAI_BACKEND_DIR: backendDir,
      // Tell the backend exactly how wide the panel is and which side it's on,
      // so screen_capture.py can crop the panel out of every screenshot.
      SIDEAI_PANEL_WIDTH: String(PANEL_WIDTH),
      SIDEAI_STRIP_WIDTH: String(STRIP_WIDTH),
      SIDEAI_SIDEBAR_POSITION: sidebarPosition,
    };

    // For the bundled executable, args are embedded; otherwise pass uvicorn args
    const spawnArgs = isPacked && fs.existsSync(bundledExecutable)
      ? ["--host", "127.0.0.1", "--port", String(BACKEND_PORT)]
      : args;

    pythonProcess = spawn(exe, spawnArgs, { cwd: backendDir, env: spawnEnv });
    pythonProcess.stderr.on("data", (d) => safeWriteToStream(process.stderr, d));
    pythonProcess.stdout.on("data", (d) => safeWriteToStream(process.stdout, d));
    pythonProcess.on("error", (err) => reject(err));
    waitForBackend().then(resolve).catch(reject);
  });
}

function waitForBackend(maxAttempts = 40) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryFetch = () => {
      const http = require("http");
      const req = http.get(HEALTH_URL, (res) => {
        if (res.statusCode === 200) { resolve(); return; }
        retry();
      });
      req.on("error", retry);
      function retry() {
        attempts++;
        if (attempts >= maxAttempts) return reject(new Error("Backend not reachable after 20 seconds"));
        setTimeout(tryFetch, 500);
      }
    };
    tryFetch();
  });
}

function stopBackend() {
  if (pythonProcess) {
    pythonProcess.kill("SIGTERM");
    pythonProcess = null;
  }
}

// ─── Port availability check ─────────────────────────────────────────────────
function checkPortFree(port) {
  return new Promise((resolve) => {
    const net = require("net");
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => { server.close(); resolve(true); });
    server.listen(port, "127.0.0.1");
  });
}

// ─── Window creation ─────────────────────────────────────────────────────────
function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const isDev = process.argv.includes("--dev");
  const loadUrl = isDev
    ? "http://localhost:5173"
    : `file://${path.join(frontendDist, "index.html")}`;

  mainWindow = new BrowserWindow({
    title: "DuckAI",
    width: PANEL_WIDTH,
    height: screenHeight,
    x: sidebarPosition === "left" ? 0 : screenWidth - PANEL_WIDTH,
    y: 0,
    frame: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (mainWindow.setVisibleOnAllWorkspaces) {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  mainWindow.loadURL(loadUrl);

  // Open all external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url) return { action: "deny" };
    const isApp = url.startsWith("http://localhost:5173") || url.startsWith("file://");
    if (!isApp) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url) return;
    const isApp = url.startsWith("http://localhost:5173") || url.startsWith("file://");
    if (!isApp) { event.preventDefault(); shell.openExternal(url); }
  });

  // Send first-run signal once the renderer is ready
  mainWindow.webContents.on("did-finish-load", () => {
    if (isFirstRun()) {
      mainWindow.webContents.send("sideai-first-run", { isFirstRun: true });
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (tray) { tray.destroy(); tray = null; }
  });

  // ── Auto-collapse: shrink to 48px strip when another app gets focus ───────
  let blurCollapseTimer = null;
  // Don't collapse during the first 2s after launch — gives the window time to appear
  const launchTime = Date.now();
  const LAUNCH_GRACE_MS = 2000;

  mainWindow.on("blur", () => {
    // Short delay avoids flickering on transient focus changes (e.g. system dialogs)
    blurCollapseTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || panelCollapsed) return;
      if (Date.now() - launchTime < LAUNCH_GRACE_MS) return;
      const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
      panelCollapsed = true;
      mainWindow.setBounds({ x: sidebarPosition === "left" ? 0 : sw - STRIP_WIDTH, y: 0, width: STRIP_WIDTH, height: sh });
      // Click-through when collapsed — mouse events pass to underlying apps (Gmail etc.)
      // The strip uses IPC to temporarily disable this when the cursor hovers over it.
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      mainWindow.webContents.send("sideai-panel-state", { collapsed: true });
      notifyBackendGeometry({ collapsed: true });
    }, 400);
  });

  mainWindow.on("focus", () => {
    if (blurCollapseTimer) { clearTimeout(blurCollapseTimer); blurCollapseTimer = null; }
    if (!mainWindow || mainWindow.isDestroyed() || !panelCollapsed) return;
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    panelCollapsed = false;
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.setBounds({ x: sidebarPosition === "left" ? 0 : sw - PANEL_WIDTH, y: 0, width: PANEL_WIDTH, height: sh });
    mainWindow.webContents.send("sideai-panel-state", { collapsed: false });
    notifyBackendGeometry({ collapsed: false });
  });

  try {
    globalShortcut.register("CommandOrControl+Shift+A", () => {
      if (!mainWindow) return;
      // If collapsed, expand first then show
      if (panelCollapsed) {
        const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
        panelCollapsed = false;
        mainWindow.setIgnoreMouseEvents(false);
        mainWindow.setBounds({ x: sidebarPosition === "left" ? 0 : sw - PANEL_WIDTH, y: 0, width: PANEL_WIDTH, height: sh });
        mainWindow.webContents.send("sideai-panel-state", { collapsed: false });
        notifyBackendGeometry({ collapsed: false });
      }
      mainWindow.show();
      mainWindow.focus();
    });
  } catch (_) {}

  refreshDynamicHotkeys();
  hotkeyRefreshTimer = setInterval(refreshDynamicHotkeys, 12000);
  startClipboardMonitor();
  startNotificationPolling();
  setupTray();
}

// ─── System tray ─────────────────────────────────────────────────────────────
function setupTray() {
  try {
    const iconPath = path.join(
      isPacked ? process.resourcesPath : path.join(rootDir, "frontend"),
      isPacked ? "frontend/dist/icon-tray.png" : "public/icon-tray.png"
    );
    const fallbackIcon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    );
    const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : fallbackIcon;
    tray = new Tray(icon.getSize().width ? icon : fallbackIcon);
    tray.setToolTip("DuckAI");
    const showAndExpand = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
      // Always fully expand — don't rely on focus event which can race on macOS
      panelCollapsed = false;
      mainWindow.setIgnoreMouseEvents(false);
      mainWindow.setBounds({ x: sidebarPosition === "left" ? 0 : sw - PANEL_WIDTH, y: 0, width: PANEL_WIDTH, height: sh });
      mainWindow.webContents.send("sideai-panel-state", { collapsed: false });
      notifyBackendGeometry({ collapsed: false });
      mainWindow.show();
      mainWindow.focus();
    };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show DuckAI", click: showAndExpand },
      { type: "separator" },
      { label: "Quit DuckAI", click: () => app.quit() },
    ]));
    mainWindow.on("close", (e) => {
      if (!app.isQuiting) { e.preventDefault(); mainWindow.hide(); }
    });
  } catch (_) {}
}

// ─── Dynamic hotkeys ──────────────────────────────────────────────────────────
function normalizeAccelerator(combo) {
  const raw = String(combo || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.split("+").map((t) => t.trim()).filter(Boolean).map((t) => {
    if (t === "cmd" || t === "command" || t === "ctrl" || t === "control") return "CommandOrControl";
    if (t === "alt" || t === "option") return "Alt";
    if (t === "shift") return "Shift";
    if (t === "meta") return "Super";
    return t.length === 1 ? t.toUpperCase() : t[0].toUpperCase() + t.slice(1);
  }).join("+");
}

async function refreshDynamicHotkeys() {
  try {
    registeredDynamicHotkeys.forEach((acc) => globalShortcut.unregister(acc));
    registeredDynamicHotkeys = [];
    const r = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/hotkeys`);
    if (!r.ok) return;
    const data = await r.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    items.forEach((item) => {
      if (!item?.enabled) return;
      const accelerator = normalizeAccelerator(item.key_combo);
      if (!accelerator) return;
      try {
        const ok = globalShortcut.register(accelerator, () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("sideai-hotkey", {
              id: item.id, template_id: item.template_id, key_combo: item.key_combo,
            });
            mainWindow.show();
            mainWindow.focus();
          }
        });
        if (ok) registeredDynamicHotkeys.push(accelerator);
      } catch (_) {}
    });
  } catch (_) {}
}

// ─── Clipboard monitor ────────────────────────────────────────────────────────
function startClipboardMonitor() {
  if (clipboardPollTimer) return;
  try { lastClipboardText = clipboard.readText() || ""; } catch (_) { lastClipboardText = ""; }
  clipboardPollTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    let current = "";
    try { current = clipboard.readText() || ""; } catch (_) { return; }
    if (!current || current === lastClipboardText) return;
    lastClipboardText = current;
    mainWindow.webContents.send("sideai-clipboard", { content: current, length: current.length });
  }, 1500);
}

function stopClipboardMonitor() {
  if (clipboardPollTimer) { clearInterval(clipboardPollTimer); clipboardPollTimer = null; }
}

function stopHotkeyRefresh() {
  if (hotkeyRefreshTimer) { clearInterval(hotkeyRefreshTimer); hotkeyRefreshTimer = null; }
}

// ─── Notification polling ─────────────────────────────────────────────────────
async function pollNotifications() {
  try {
    try { await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/daily-life/tick`, { method: "POST" }); } catch (_) {}
    const r = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/notifications`);
    if (!r.ok) return;
    const data = await r.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    const now = Date.now();
    for (const item of items) {
      if (!item?.id || seenNotificationIds.has(item.id)) continue;
      seenNotificationIds.add(item.id);
      if (item.read) continue;
      const createdMs = item.created_at ? Date.parse(item.created_at) : NaN;
      const ageMs = Number.isFinite(createdMs) ? now - createdMs : Infinity;
      const fresh = Number.isFinite(createdMs) && ageMs >= -120000 && ageMs <= NOTIFICATION_TOAST_MAX_AGE_MS;
      if (!fresh || !Notification.isSupported()) continue;
      try {
        const notification = new Notification({
          title: item.title || "DuckAI",
          body: (item.body && String(item.body).trim()) || "Open DuckAI for details.",
          silent: false,
        });
        notification.on("click", () => mainWindow && (mainWindow.show(), mainWindow.focus()));
        notification.show();
      } catch (err) { console.warn("DuckAI notification:", err); }
    }
  } catch (_) {}
}

function startNotificationPolling() {
  if (notificationPollTimer) return;
  pollNotifications();
  notificationPollTimer = setInterval(pollNotifications, 5000);
}

function stopNotificationPolling() {
  if (notificationPollTimer) { clearInterval(notificationPollTimer); notificationPollTimer = null; }
}

// ─── Electron-side screen capture (fallback only) ────────────────────────────
// The backend uses CGWindowListCreateImage to capture excluding DuckAI's own window
// (no hide, no flicker — macOS composites everything below DuckAI like glass).
// This fallback is used when the Python process lacks Screen Recording permission.
// It hides the panel for ~200 ms, captures, then restores — barely noticeable.

let _captureLock = false;

async function _captureViaElectron() {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, reason: "no_window" };
  if (_captureLock) return { ok: false, reason: "capture_in_progress" };
  _captureLock = true;
  try {
    const { desktopCapturer } = require("electron");
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = primaryDisplay.size;

    // Hide panel so DuckAI is absent from the screenshot
    mainWindow.hide();
    await new Promise(r => setTimeout(r, 150));

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: sw, height: sh },
    });

    if (!mainWindow.isDestroyed()) mainWindow.show();

    if (!sources.length) return { ok: false, reason: "no_sources" };
    const dataUrl = sources[0].thumbnail.toDataURL();
    if (!dataUrl || dataUrl.length < 200) return { ok: false, reason: "empty_image" };

    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/ingest_screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_data: dataUrl, full_screen: true }),
    });
    if (!res.ok) return { ok: false, reason: `ingest_${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { ok: true, visible_text_len: data.visible_text_len ?? 0, ocr_confidence: data.ocr_confidence ?? 0 };
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    return { ok: false, reason: String(e) };
  } finally {
    _captureLock = false;
  }
}

// Primary entry point: ask backend to do the see-through capture via CGWindowListCreateImage.
// Falls back to _captureViaElectron (hide-show) only if Python lacks Screen Recording.
async function captureScreen() {
  try {
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/capture_screen_excluding_self`, {
      method: "POST",
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.ok && data.visible_text_len > 30) {
        return { ok: true, visible_text_len: data.visible_text_len, source: "cg_native" };
      }
    }
  } catch (_) {}
  // Fallback: Electron hide-show capture
  return _captureViaElectron();
}

function startElectronCapture() {}   // captures are on-demand only
function stopElectronCapture() {}

// ─── Backend geometry sync ─────────────────────────────────────────────────────
function notifyBackendGeometry({ width, strip_width, collapsed, position } = {}) {
  const body = {};
  if (width !== undefined) body.width = width;
  if (strip_width !== undefined) body.strip_width = strip_width;
  if (collapsed !== undefined) body.collapsed = collapsed;
  if (position !== undefined) body.position = position;
  fetch(`http://127.0.0.1:${BACKEND_PORT}/api/panel_geometry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.on("sideai-toggle-panel", () => {
  if (!mainWindow) return;
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  panelCollapsed = !panelCollapsed;
  const w = panelCollapsed ? STRIP_WIDTH : PANEL_WIDTH;
  if (panelCollapsed) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
  mainWindow.setBounds({ x: sidebarPosition === "left" ? 0 : screenWidth - w, y: 0, width: w, height: screenHeight });
  notifyBackendGeometry({ collapsed: panelCollapsed });
});

// Strip hover — temporarily make the collapsed strip interactive so its buttons work
ipcMain.on("sideai-strip-enter", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIgnoreMouseEvents(false);
});
ipcMain.on("sideai-strip-leave", () => {
  if (panelCollapsed && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }
});

ipcMain.on("sideai-set-sidebar-position", (_event, payload) => {
  if (!mainWindow) return;
  const next = String(payload?.position || "").toLowerCase();
  if (next !== "left" && next !== "right") return;
  sidebarPosition = next;
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const [currentWidth] = mainWindow.getSize();
  mainWindow.setBounds({ x: sidebarPosition === "left" ? 0 : screenWidth - currentWidth, y: 0, width: currentWidth, height: screenHeight });
  notifyBackendGeometry({ position: next });
});

ipcMain.on("sideai-set-panel-width", (_event, payload) => {
  if (!mainWindow || panelCollapsed) return;
  const width = Math.max(280, Math.min(600, Number(payload?.width || PANEL_WIDTH)));
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow.setBounds({ x: sidebarPosition === "left" ? 0 : screenWidth - width, y: 0, width, height: screenHeight });
  notifyBackendGeometry({ width });
});

ipcMain.on("sideai-set-panel-opacity", (_event, payload) => {
  if (!mainWindow) return;
  mainWindow.setOpacity(Math.max(0.5, Math.min(1, Number(payload?.opacity || 1))));
});

ipcMain.handle("sideai-copy-to-clipboard", (_event, text) => {
  if (typeof text === "string" && text.trim()) { clipboard.writeText(text.trim()); return true; }
  return false;
});

ipcMain.handle("sideai-open-backend-folder", async () => {
  try {
    const err = await shell.openPath(backendDir);
    return { ok: !err, error: err || null };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("sideai-capture-screen", async () => captureScreen());

ipcMain.handle("sideai-open-screen-privacy", async () => {
  try {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("sideai-open-accessibility", async () => {
  try {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("sideai-onboarding-done", async () => {
  try {
    fs.writeFileSync(ONBOARDING_MARKER, new Date().toISOString(), "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// ─── Screen Recording — prompt only when capture is actually unhealthy ────────
async function backendCaptureHealthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/permissions/health`);
    if (!r.ok) return false;
    const d = await r.json();
    return d?.screen_recording?.ok === true;
  } catch (_) {
    return false;
  }
}

async function promptScreenRecordingIfNeeded() {
  if (process.platform !== "darwin") return;
  if (await backendCaptureHealthy()) return;

  const { systemPreferences } = require("electron");
  const status = systemPreferences.getMediaAccessStatus("screen");

  if (status === "granted") {
    await dialog.showMessageBox({
      type: "info",
      title: "Screen context not ready",
      message: "Screen Recording is enabled, but DuckAI could not read text yet.",
      detail:
        "Collapse DuckAI to the side strip so it can capture your screen, ensure Tesseract is installed (brew install tesseract), and in dev mode enable Screen Recording for Python/Terminal as well as Electron.",
      buttons: ["OK"],
    });
    return;
  }

  await shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  );
  await dialog.showMessageBox({
    type: "info",
    title: "Screen Recording needed",
    message: "DuckAI needs Screen Recording to see your screen and help in real time.",
    detail:
      "In System Settings → Privacy & Security → Screen Recording, enable DuckAI (or Electron in dev). In dev, also enable Python/Terminal. Then relaunch DuckAI.",
    buttons: ["OK"],
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const portFree = await checkPortFree(BACKEND_PORT);
  if (!portFree) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "Port conflict",
      message: `Port ${BACKEND_PORT} is already in use`,
      detail: `Another process is occupying port ${BACKEND_PORT}, which DuckAI's backend needs.\n\nClose the other application and relaunch DuckAI, or click "Continue anyway" to open the UI in offline mode.`,
      buttons: ["Quit DuckAI", "Continue anyway"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) { app.quit(); return; }
    // User chose to continue — skip backend launch, open window in offline mode
    createWindow();
    return;
  }

  startBackend()
    .then(async () => {
      await promptScreenRecordingIfNeeded();
      createWindow();
      startElectronCapture();
    })
    .catch((err) => {
      console.error("Backend failed to start:", err);
      createWindow();
    });
});

app.on("window-all-closed", () => {
  globalShortcut.unregisterAll();
  stopHotkeyRefresh();
  stopClipboardMonitor();
  stopNotificationPolling();
  stopElectronCapture();
  stopBackend();
  if (!tray) app.quit();
});

app.on("quit", () => {
  app.isQuiting = true;
  globalShortcut.unregisterAll();
  stopHotkeyRefresh();
  stopClipboardMonitor();
  stopNotificationPolling();
  stopElectronCapture();
  stopBackend();
});
