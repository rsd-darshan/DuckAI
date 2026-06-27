const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sideai", {
  togglePanel: () => {
    try { ipcRenderer.send("sideai-toggle-panel"); } catch (_) {}
  },
  onHotkeyTriggered: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("sideai-hotkey", listener);
    return () => ipcRenderer.removeListener("sideai-hotkey", listener);
  },
  onClipboardChanged: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("sideai-clipboard", listener);
    return () => ipcRenderer.removeListener("sideai-clipboard", listener);
  },
  onFirstRun: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("sideai-first-run", listener);
    return () => ipcRenderer.removeListener("sideai-first-run", listener);
  },
  setSidebarPosition: (position) => {
    try { ipcRenderer.send("sideai-set-sidebar-position", { position }); } catch (_) {}
  },
  setPanelWidth: (width) => {
    try { ipcRenderer.send("sideai-set-panel-width", { width }); } catch (_) {}
  },
  setPanelOpacity: (opacity) => {
    try { ipcRenderer.send("sideai-set-panel-opacity", { opacity }); } catch (_) {}
  },
  copyToClipboard: (text) => ipcRenderer.invoke("sideai-copy-to-clipboard", text),
  openBackendFolder: () => ipcRenderer.invoke("sideai-open-backend-folder"),
  captureScreen: () => ipcRenderer.invoke("sideai-capture-screen"),
  openScreenPrivacySettings: () => ipcRenderer.invoke("sideai-open-screen-privacy"),
  openAccessibilitySettings: () => ipcRenderer.invoke("sideai-open-accessibility"),
  onboardingDone: () => ipcRenderer.invoke("sideai-onboarding-done"),
  stripMouseEnter: () => { try { ipcRenderer.send("sideai-strip-enter"); } catch (_) {} },
  stripMouseLeave: () => { try { ipcRenderer.send("sideai-strip-leave"); } catch (_) {} },
  onPanelState: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("sideai-panel-state", listener);
    return () => ipcRenderer.removeListener("sideai-panel-state", listener);
  },
});
