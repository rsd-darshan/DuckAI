import * as vscode from "vscode";
import { chat, chatStream, ChatMessage } from "./client";

/** Get the selected text from the active editor (or whole file if nothing selected). */
function getSelection(editor: vscode.TextEditor, fallback: "file" | "none" = "none"): string {
  const sel = editor.selection;
  if (!sel.isEmpty) return editor.document.getText(sel);
  if (fallback === "file") return editor.document.getText();
  return "";
}

function getFileContext(editor: vscode.TextEditor): string {
  const lang = editor.document.languageId;
  const name = editor.document.fileName.split("/").pop() ?? "";
  return `File: ${name} (${lang})`;
}

/** Show the AI response in an output channel. */
const outputChannel = vscode.window.createOutputChannel("SideAI");

async function showStreamingResponse(
  title: string,
  messages: ChatMessage[],
  context: string
): Promise<void> {
  outputChannel.show(true);
  outputChannel.appendLine(`\n${"─".repeat(60)}`);
  outputChannel.appendLine(`▶ ${title}`);
  outputChannel.appendLine(`${"─".repeat(60)}`);

  let totalTokens = 0;
  try {
    await chatStream(messages, context, (chunk) => {
      process.stdout.write(chunk); // for debugging
      outputChannel.append(chunk);
      totalTokens++;
    });
  } catch (e) {
    // Fallback to non-streaming
    const r = await chat(messages, context);
    if (r.error) {
      outputChannel.appendLine(`\n[Error: ${r.error}]`);
    } else {
      outputChannel.appendLine(r.reply);
    }
  }
  outputChannel.appendLine(`\n${"─".repeat(60)}\n`);
}

export async function askAboutSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage("Open a file first"); return; }

  const selection = getSelection(editor, "none");
  if (!selection) { vscode.window.showWarningMessage("Select some code or text first"); return; }

  const question = await vscode.window.showInputBox({
    prompt: "What do you want to know?",
    placeHolder: "e.g. What does this function do? Is there a bug here?",
  });
  if (!question) return;

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: `${question}\n\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\``,
    },
  ];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SideAI thinking…", cancellable: false },
    () => showStreamingResponse(`Ask: ${question.slice(0, 60)}`, messages, getFileContext(editor))
  );
}

export async function reviewCode() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage("Open a file first"); return; }

  const code = editor.document.getText();
  const lang = editor.document.languageId;
  const fileName = editor.document.fileName.split("/").pop() ?? "";

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: `Please review this ${lang} code in ${fileName}. Look for bugs, performance issues, security problems, and code quality. Be specific and concise.\n\n\`\`\`${lang}\n${code.slice(0, 8000)}\n\`\`\``,
    },
  ];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SideAI reviewing…", cancellable: false },
    () => showStreamingResponse(`Code Review: ${fileName}`, messages, getFileContext(editor))
  );
}

export async function explainCode() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage("Open a file first"); return; }

  const selection = getSelection(editor, "file");
  if (!selection) return;

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: `Explain this ${editor.document.languageId} code clearly and concisely:\n\n\`\`\`${editor.document.languageId}\n${selection.slice(0, 6000)}\n\`\`\``,
    },
  ];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SideAI explaining…", cancellable: false },
    () => showStreamingResponse("Explain Code", messages, getFileContext(editor))
  );
}

export async function fixCode() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage("Open a file first"); return; }

  const selection = getSelection(editor, "none");
  if (!selection) { vscode.window.showWarningMessage("Select the code you want fixed first"); return; }

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: `Fix or improve this ${editor.document.languageId} code. Return ONLY the corrected code, no explanation:\n\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\``,
    },
  ];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SideAI fixing…", cancellable: false },
    async () => {
      const r = await chat(messages, getFileContext(editor));
      if (r.error) { vscode.window.showErrorMessage(`SideAI error: ${r.error}`); return; }

      // Extract code block from response
      let fixed = r.reply.trim();
      const codeMatch = fixed.match(/```(?:\w+)?\n([\s\S]*?)```/);
      if (codeMatch) fixed = codeMatch[1].trim();

      const action = await vscode.window.showInformationMessage(
        "SideAI has a fix ready. What do you want to do?",
        "Replace Selection",
        "Insert Below",
        "Copy"
      );

      if (action === "Replace Selection") {
        editor.edit((eb) => eb.replace(editor.selection, fixed));
      } else if (action === "Insert Below") {
        const end = editor.selection.end;
        editor.edit((eb) => eb.insert(end, "\n\n" + fixed));
      } else if (action === "Copy") {
        await vscode.env.clipboard.writeText(fixed);
        vscode.window.showInformationMessage("Fixed code copied to clipboard");
      }
    }
  );
}

export async function insertSuggestion() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage("Open a file first"); return; }

  const prompt = await vscode.window.showInputBox({
    prompt: "What should SideAI write?",
    placeHolder: "e.g. Add error handling, write unit tests for this function",
  });
  if (!prompt) return;

  const context = `${getFileContext(editor)}\n\n${editor.document.getText().slice(0, 4000)}`;
  const messages: ChatMessage[] = [
    { role: "user", content: `${prompt}\n\nReturn ONLY the code to insert, no explanation.` },
  ];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SideAI generating…", cancellable: false },
    async () => {
      const r = await chat(messages, context);
      if (r.error) { vscode.window.showErrorMessage(`SideAI error: ${r.error}`); return; }

      let code = r.reply.trim();
      const codeMatch = code.match(/```(?:\w+)?\n([\s\S]*?)```/);
      if (codeMatch) code = codeMatch[1].trim();

      editor.edit((eb) => eb.insert(editor.selection.active, code));
    }
  );
}
