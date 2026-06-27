import type { ChatMessage } from "../hooks/useBackend";

export type SourceHit = { title: string; url: string; snippet: string };

export function buildChatMarkdownExport(options: {
  messages: ChatMessage[];
  sources?: SourceHit[] | null;
  appContext?: string;
  windowTitle?: string;
  exportedAt?: Date;
}): string {
  const { messages, sources, appContext, windowTitle, exportedAt = new Date() } = options;
  const lines: string[] = [
    "# DuckAI transcript",
    "",
    `- Exported: ${exportedAt.toISOString()}`,
  ];
  if (appContext?.trim()) lines.push(`- App context: ${appContext.trim()}`);
  if (windowTitle?.trim()) lines.push(`- Focused window: ${windowTitle.trim()}`);
  lines.push("", "---", "");

  for (const m of messages) {
    const who = m.role === "user" ? "User" : "Assistant";
    lines.push(`## ${who}`, "", m.content.trim(), "", "---", "");
  }

  if (sources && sources.length > 0) {
    lines.push("## Sources", "");
    sources.forEach((h, i) => {
      const title = h.title || "Untitled";
      const snip = (h.snippet || "").trim();
      lines.push(`### ${i + 1}. ${title}`, "", snip, "", h.url, "", "");
    });
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function downloadTextFile(filename: string, content: string, mime = "text/markdown;charset=utf-8"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
