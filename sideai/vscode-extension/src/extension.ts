import * as vscode from "vscode";
import { initStatusBar } from "./statusBar";
import { openSideAIPanel, SideAISidebarProvider } from "./panel";
import {
  askAboutSelection,
  reviewCode,
  explainCode,
  fixCode,
  insertSuggestion,
} from "./commands";

export function activate(context: vscode.ExtensionContext) {
  // Status bar
  initStatusBar(context);

  // Activity bar sidebar webview
  const sidebarProvider = new SideAISidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("sideai.panel", sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("sideai.askAboutSelection", askAboutSelection),
    vscode.commands.registerCommand("sideai.reviewCode", reviewCode),
    vscode.commands.registerCommand("sideai.explainCode", explainCode),
    vscode.commands.registerCommand("sideai.fixCode", fixCode),
    vscode.commands.registerCommand("sideai.insertSuggestion", insertSuggestion),
    vscode.commands.registerCommand("sideai.openPanel", () => openSideAIPanel(context))
  );

  // Show welcome notification on first install
  const installed = context.globalState.get<boolean>("sideai.installed");
  if (!installed) {
    context.globalState.update("sideai.installed", true);
    vscode.window.showInformationMessage(
      "SideAI is connected. Select code and press Cmd+Shift+A to ask about it.",
      "Open SideAI"
    ).then((choice) => {
      if (choice === "Open SideAI") openSideAIPanel(context);
    });
  }
}

export function deactivate() {}
