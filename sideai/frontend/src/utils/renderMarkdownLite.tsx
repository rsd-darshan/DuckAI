import type { ReactNode } from "react";

/** Inline **bold**, *italic*, escaped \* */
export function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const len = text.length;
  let i = 0;
  let keyCounter = 0;

  const pushText = (t: string) => {
    if (t) nodes.push(t);
  };

  while (i < len) {
    const nextStar = text.indexOf("*", i);
    if (nextStar === -1) {
      pushText(text.slice(i));
      break;
    }

    if (nextStar > 0 && text[nextStar - 1] === "\\") {
      pushText(text.slice(i, nextStar - 1));
      nodes.push("*");
      i = nextStar + 1;
      continue;
    }

    pushText(text.slice(i, nextStar));
    i = nextStar;

    if (text.startsWith("**", i)) {
      const closing = text.indexOf("**", i + 2);
      if (closing !== -1) {
        const content = text.slice(i + 2, closing);
        nodes.push(
          <strong key={`md-b-${keyCounter++}`} className="font-semibold text-[color:var(--panel-text)]">
            {content}
          </strong>
        );
        i = closing + 2;
        continue;
      }
      nodes.push("**");
      i += 2;
      continue;
    }

    if (text[i] === "*") {
      const closing = text.indexOf("*", i + 1);
      if (closing !== -1) {
        const content = text.slice(i + 1, closing);
        nodes.push(
          <em key={`md-i-${keyCounter++}`} className="italic text-[color:var(--panel-text)]">
            {content}
          </em>
        );
        i = closing + 1;
        continue;
      }
      nodes.push("*");
      i += 1;
      continue;
    }

    pushText(text[i]);
    i += 1;
  }

  return nodes;
}

const BULLET_LINE = /^(\*|-|\d+\.)\s+(.+)$/;

/**
 * Block-level formatting for assistant-style answers: paragraphs, blank lines, and
 * markdown-ish bullets so "* foo **bar**" does not get parsed as italic.
 */
export function renderMarkdownAnswer(text: string): ReactNode {
  if (!text.trim()) return null;

  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: ReactNode[] = [];
  let listBuf: ReactNode[] = [];
  let listOrdered = false;
  let key = 0;

  const flushList = () => {
    if (listBuf.length === 0) return;
    const ListTag = listOrdered ? "ol" : "ul";
    blocks.push(
      <ListTag
        key={`list-${key++}`}
        className={
          listOrdered
            ? "list-decimal pl-4 space-y-1 my-1 text-[color:var(--panel-text)]"
            : "list-disc pl-4 space-y-1 my-1 text-[color:var(--panel-text)]"
        }
      >
        {listBuf}
      </ListTag>
    );
    listBuf = [];
    listOrdered = false;
  };

  for (const raw of lines) {
    if (raw.trim() === "") {
      flushList();
      blocks.push(<div key={`sp-${key++}`} className="h-2 shrink-0" aria-hidden />);
      continue;
    }

    const ts = raw.trimStart();
    const m = ts.match(BULLET_LINE);

    if (m) {
      const isOrdered = /^\d+\.$/.test(m[1]);
      if (listBuf.length > 0 && listOrdered !== isOrdered) {
        flushList();
      }
      listOrdered = isOrdered;
      listBuf.push(
        <li key={`li-${key++}`} className="leading-relaxed pl-0.5">
          {renderInlineMarkdown(m[2])}
        </li>
      );
      continue;
    }

    flushList();

    blocks.push(
      <p key={`p-${key++}`} className="leading-relaxed text-[color:var(--panel-text)] my-0.5 first:mt-0 last:mb-0">
        {renderInlineMarkdown(raw.trim())}
      </p>
    );
  }

  flushList();

  return <div className="space-y-0">{blocks}</div>;
}
