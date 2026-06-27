import * as vscode from "vscode";
import { healthCheck } from "./client";

let statusBarItem: vscode.StatusBarItem;
let pollTimer: NodeJS.Timer | undefined;

export function initStatusBar(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "sideai.openPanel";
  statusBarItem.tooltip = "SideAI — click to open panel";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  updateStatus();
  pollTimer = setInterval(updateStatus, 10000);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer as NodeJS.Timeout) });
}

async function updateStatus() {
  const alive = await healthCheck();
  if (alive) {
    statusBarItem.text = "$(layout-sidebar-right) SideAI";
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = "$(layout-sidebar-right-off) SideAI offline";
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
}
