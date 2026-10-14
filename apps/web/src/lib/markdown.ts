/**
 * Bidirectional Markdown <-> HTML for the TipTap editor.
 *
 * On the read path we feed Markdown through `marked` to build initial HTML.
 * On the write path we go the other way with `turndown`. The point is that
 * the *source of truth* on disk and in the database is always Markdown, so
 * agents and external tools can read and write content without learning a
 * proprietary editor schema.
 */
import { marked } from "marked";
import TurndownService from "turndown";
import { tables as gfmTables } from "turndown-plugin-gfm";

marked.setOptions({
  gfm: true,
  breaks: false,
});

const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;

// GFM alerts (> [!NOTE] …) render as callout divs the editor's Callout
// node understands; anything else stays a plain blockquote.
marked.use({
  renderer: {
    blockquote({ tokens }) {
      const inner = this.parser.parse(tokens);
      const m = /^<p>\[!(\w+)\]\s*(?:<br\s*\/?>)?\s*/i.exec(inner);
      const kind = m?.[1]?.toLowerCase();
      if (m && kind && (CALLOUT_KINDS as readonly string[]).includes(kind)) {
        const body = inner.replace(m[0], "<p>").replace(/<p><\/p>/g, "");
        return `<div data-type="callout" data-callout="${kind}">${body}</div>`;
      }
      return `<blockquote>${inner}</blockquote>`;
    },
  },
});

let turndown: TurndownService | null = null;

function getTurndown() {
  if (turndown) return turndown;
  turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  // GFM pipe tables — TipTap's table HTML back to Markdown. Registered
  // before custom rules so our overrides still win where they overlap.
  turndown.use(gfmTables);
  turndown.addRule("callout", {
    filter: (node) =>
      node.nodeName === "DIV" &&
      node instanceof HTMLElement &&
      node.getAttribute("data-type") === "callout",
    replacement: (content, node) => {
      const kind = (
        (node as HTMLElement).getAttribute("data-callout") || "note"
      ).toUpperCase();
      const quoted = content
        .trim()
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
      return `\n\n> [!${kind}]\n${quoted}\n\n`;
    },
  });
  turndown.addRule("taskList", {
    filter: (node) =>
      node.nodeName === "LI" &&
      node.parentNode instanceof HTMLElement &&
      node.parentNode.getAttribute("data-type") === "taskList",
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const checked = el.getAttribute("data-checked") === "true";
      return `- [${checked ? "x" : " "}] ${content.trim()}\n`;
    },
  });
  return turndown;
}

export function markdownToHtml(md: string): string {
  if (!md) return "";
  return marked.parse(md, { async: false }) as string;
}

export function htmlToMarkdown(html: string): string {
  if (!html) return "";
  return getTurndown().turndown(html);
}
