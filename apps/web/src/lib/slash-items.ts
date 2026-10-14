/**
 * The editor's `/` command palette: every block a person can insert by typing
 * a slash, with the TipTap chain that inserts it. Rendered by
 * `components/slash-menu.tsx`; items that need UI beyond the editor (image
 * picker, AI autofix) dispatch a window event the editor shell listens for
 * rather than importing it, so this list stays free of React.
 */
import type { Editor, Range } from "@tiptap/core";
import {
  AtSign,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Info,
  ListChecks,
  ListIcon,
  MessageSquareQuote,
  Table2,
  Wand2,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export type SlashItem = {
  title: string;
  description: string;
  keywords: string[];
  shortcut?: string;
  /** Leading icon rendered by the HeroUI-styled slash menu list. */
  icon: LucideIcon;
  command: (props: { editor: Editor; range: Range }) => void;
};

type ChainBuilder = ReturnType<Editor["chain"]>;

function run(
  editor: Editor,
  range: Range,
  build: (chain: ChainBuilder) => ChainBuilder,
): void {
  build(editor.chain().focus().deleteRange(range)).run();
}

const slashItems: SlashItem[] = [
  {
    title: "Heading 1",
    icon: Heading1,
    description: "Large section heading",
    keywords: ["h1", "title"],
    shortcut: "/h1",
    command: ({ editor, range }) =>
      run(editor, range, (c) => c.setNode("heading", { level: 1 })),
  },
  {
    title: "Heading 2",
    icon: Heading2,
    description: "Medium section heading",
    keywords: ["h2"],
    shortcut: "/h2",
    command: ({ editor, range }) =>
      run(editor, range, (c) => c.setNode("heading", { level: 2 })),
  },
  {
    title: "Heading 3",
    icon: Heading3,
    description: "Small section heading",
    keywords: ["h3"],
    shortcut: "/h3",
    command: ({ editor, range }) =>
      run(editor, range, (c) => c.setNode("heading", { level: 3 })),
  },
  {
    title: "Bullet list",
    icon: ListIcon,
    description: "Unordered list",
    keywords: ["ul", "bullets"],
    shortcut: "/ul",
    command: ({ editor, range }) =>
      run(editor, range, (c) => c.toggleBulletList()),
  },
  {
    title: "Task list",
    icon: ListChecks,
    description: "Checkable to-do list",
    keywords: ["todo", "checkbox"],
    shortcut: "/t",
    command: ({ editor, range }) =>
      run(editor, range, (c) => c.toggleTaskList()),
  },
  {
    title: "Code block",
    icon: Code2,
    description: "Fenced code with syntax highlighting",
    keywords: ["code", "snippet", "pre"],
    shortcut: "/c",
    command: ({ editor, range }) =>
      run(editor, range, (c) => c.toggleCodeBlock()),
  },
  {
    title: "Quote",
    icon: MessageSquareQuote,
    description: "Blockquote",
    keywords: ["blockquote", "quotation"],
    shortcut: "/q",
    command: ({ editor, range }) =>
      run(editor, range, (c) => c.toggleBlockquote()),
  },
  {
    title: "Mermaid diagram",
    icon: Workflow,
    description: "Flowchart or sequence diagram rendered from text",
    keywords: ["diagram", "flowchart", "chart", "graph", "sequence"],
    shortcut: "/mermaid",
    command: ({ editor, range }) =>
      run(editor, range, (c) =>
        c.insertContent({
          type: "codeBlock",
          attrs: { language: "mermaid" },
          content: [
            { type: "text", text: "graph TD\n  A[Start] --> B{Decision}\n  B -->|yes| C[Ship]\n  B -->|no| D[Iterate]" },
          ],
        }),
      ),
  },
  {
    title: "Callout",
    icon: Info,
    description: "Highlighted note box (note, tip, warning)",
    keywords: ["note", "tip", "warning", "alert", "admonition", "box"],
    shortcut: "/note",
    command: ({ editor, range }) =>
      run(editor, range, (c) =>
        c.wrapIn("callout", { kind: "note" }),
      ),
  },
  {
    title: "Table",
    icon: Table2,
    description: "Insert a 3×3 table with a header row",
    keywords: ["grid", "columns", "rows"],
    shortcut: "/table",
    command: ({ editor, range }) =>
      run(editor, range, (c) =>
        c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
      ),
  },
  {
    title: "Autofix",
    icon: Wand2,
    description: "Restructure this note with AI, review before applying",
    keywords: ["ai", "rewrite", "clean", "format", "fix"],
    shortcut: "/fix",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("bcontext:autofix"));
      }
    },
  },
  {
    title: "Image",
    icon: ImageIcon,
    description: "Insert an image (paste, drop, or pick a file)",
    keywords: ["picture", "photo", "upload"],
    shortcut: "/img",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("bcontext:slash-image"));
      }
    },
  },
  {
    title: "Mention",
    icon: AtSign,
    description: "Reference another node",
    keywords: ["link", "ref", "at"],
    shortcut: "@",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent("@").run(),
  },
];

/** Case-insensitive match on title or keywords; an empty query lists everything. */
export function filterSlashItems(query: string, items = slashItems): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    if (item.title.toLowerCase().includes(q)) return true;
    return item.keywords.some((k) => k.toLowerCase().includes(q));
  });
}
