import * as vscode from "vscode";
import { backendUrl } from "./client";

let currentPanel: vscode.WebviewPanel | undefined;

export function openSideAIPanel(context: vscode.ExtensionContext) {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    "sideai.panel",
    "SideAI",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    }
  );

  currentPanel.webview.html = getPanelHtml(backendUrl());

  currentPanel.webview.onDidReceiveMessage(
    (message) => {
      if (message.type === "copyToClipboard" && message.text) {
        vscode.env.clipboard.writeText(message.text);
        vscode.window.showInformationMessage("Copied to clipboard");
      }
      if (message.type === "insertAtCursor" && message.text) {
        insertTextAtCursor(message.text);
      }
    },
    undefined,
    context.subscriptions
  );

  currentPanel.onDidDispose(() => { currentPanel = undefined; }, null, context.subscriptions);
}

function insertTextAtCursor(text: string) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  editor.edit((editBuilder) => {
    editBuilder.insert(editor.selection.active, text);
  });
}

/** Embeds the SideAI React UI inside the webview via iframe pointing at the local backend. */
function getPanelHtml(baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en" style="margin:0;padding:0;height:100%;width:100%">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SideAI</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { height: 100vh; width: 100vw; background: #0f0f13; display: flex; flex-direction: column; font-family: system-ui; }
    #toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #1a1a22; border-bottom: 1px solid rgba(255,255,255,0.08); }
    #toolbar span { color: rgba(255,255,255,0.5); font-size: 12px; flex: 1; }
    button { background: rgba(99,102,241,0.8); color: white; border: none; border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer; }
    button:hover { background: rgba(99,102,241,1); }
    iframe { flex: 1; border: none; width: 100%; background: #0f0f13; }
    #offline { display: none; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 16px; color: rgba(255,255,255,0.5); font-size: 14px; text-align: center; padding: 32px; }
  </style>
</head>
<body>
  <div id="toolbar">
    <span>SideAI</span>
    <button onclick="reload()">↺ Refresh</button>
  </div>
  <iframe id="frame" src="${baseUrl}" allow="clipboard-read; clipboard-write"></iframe>
  <div id="offline">
    <div style="font-size:32px">🔌</div>
    <div>SideAI backend is not running</div>
    <div style="font-size:12px">Start it with: <code style="background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:4px">npm start</code> in the sideai folder</div>
    <button onclick="reload()">Try again</button>
  </div>
  <script>
    const frame = document.getElementById('frame');
    const offline = document.getElementById('offline');
    const vscode = acquireVsCodeApi();

    frame.onerror = () => { frame.style.display='none'; offline.style.display='flex'; };

    // Poll backend health
    async function checkHealth() {
      try {
        const r = await fetch('${baseUrl}/health');
        if (r.ok) {
          frame.style.display = '';
          offline.style.display = 'none';
        } else throw new Error();
      } catch {
        frame.style.display = 'none';
        offline.style.display = 'flex';
      }
    }
    checkHealth();
    setInterval(checkHealth, 10000);

    function reload() { frame.src = '${baseUrl}?' + Date.now(); }

    // Listen for messages from the iframe
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'sideai-copy') {
        vscode.postMessage({ type: 'copyToClipboard', text: e.data.text });
      }
      if (e.data?.type === 'sideai-insert') {
        vscode.postMessage({ type: 'insertAtCursor', text: e.data.text });
      }
    });
  </script>
</body>
</html>`;
}

/** Sidebar webview provider — renders the SideAI panel in the activity bar sidebar. */
export class SideAISidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = getPanelHtml(backendUrl());

    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.type === "insertAtCursor" && message.text) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          editor.edit((eb) => eb.insert(editor.selection.active, message.text));
        }
      }
    });
  }
}
