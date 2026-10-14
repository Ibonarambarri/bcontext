"use client";

/**
 * Formatting toolbar and word-count footer rendered by `editor.tsx` around
 * `EditorContent`. Both read the editor through `useEditorState` selectors,
 * so they re-render on the marks/text they show and not on every
 * transaction.
 */
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import {
  Bold,
  Code,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  Unlink,
} from "lucide-react";
import { Button, Separator, Tooltip } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";

/**
 * A small, additive formatting toolbar for the Tiptap engine. The editor's
 * primary authoring surface stays slash-menu-first (`/`) — this just gives
 * mouse/trackpad users the same handful of commands without hunting for
 * the slash menu, shaped like a rich-text editor's toolbar while staying wired to the existing `editor.chain()` commands.
 */
export function EditorToolbar({ editor }: { editor: Editor | null }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed) return null;
      return {
        bold: ed.isActive("bold"),
        italic: ed.isActive("italic"),
        code: ed.isActive("code"),
        heading: ed.isActive("heading", { level: 2 }),
        bulletList: ed.isActive("bulletList"),
        orderedList: ed.isActive("orderedList"),
        link: ed.isActive("link"),
      };
    },
  });

  if (!editor || !active) return null;

  const items: Array<{
    id: string;
    label: string;
    Icon: typeof Bold;
    isActive: boolean;
    onPress: () => void;
  }> = [
    {
      id: "bold",
      label: "Bold",
      Icon: Bold,
      isActive: active.bold,
      onPress: () => editor.chain().focus().toggleBold().run(),
    },
    {
      id: "italic",
      label: "Italic",
      Icon: Italic,
      isActive: active.italic,
      onPress: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      id: "code",
      label: "Inline code",
      Icon: Code,
      isActive: active.code,
      onPress: () => editor.chain().focus().toggleCode().run(),
    },
    {
      id: "heading",
      label: "Heading",
      Icon: Heading2,
      isActive: active.heading,
      onPress: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      id: "bulletList",
      label: "Bullet list",
      Icon: List,
      isActive: active.bulletList,
      onPress: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      id: "orderedList",
      label: "Numbered list",
      Icon: ListOrdered,
      isActive: active.orderedList,
      onPress: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      id: "link",
      label: active.link ? "Remove link" : "Add link",
      Icon: active.link ? Unlink : Link2,
      isActive: active.link,
      onPress: () => {
        if (active.link) {
          editor.chain().focus().extendMarkRange("link").unsetLink().run();
          return;
        }
        const url = window.prompt("Link URL");
        if (!url) return;
        editor.chain().focus().extendMarkRange("link").toggleLink({ href: url }).run();
      },
    },
  ];

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-0.5 rounded-lg border border-[var(--line)] bg-[var(--paper-2)]/95 p-1 backdrop-blur supports-[backdrop-filter]:bg-[var(--paper-2)]/80"
    >
      {items.map(({ id, label, Icon, isActive, onPress }, index) => (
        <span key={id} className="flex items-center gap-0.5">
          {index === 4 ? <Separator orientation="vertical" className="mx-0.5 h-4" /> : null}
          <Tooltip delay={400}>
            <Button
              isIconOnly
              variant="ghost"
              onPress={onPress}
              aria-label={label}
              aria-pressed={isActive}
              className={cn("icon-btn", isActive && "bg-[var(--paper-3)] text-[var(--ink)]")}
            >
              <Icon size={13} />
            </Button>
            <Tooltip.Content>{label}</Tooltip.Content>
          </Tooltip>
        </span>
      ))}
    </div>
  );
}

/** Word/character count footer — a plain-text character count. */
export function EditorFooter({ editor }: { editor: Editor | null }) {
  const counts = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed) return { words: 0, chars: 0 };
      const text = ed.getText();
      const trimmed = text.trim();
      return {
        words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
        chars: text.length,
      };
    },
  });

  if (!editor || !counts) return null;

  return (
    <div className="mono mt-6 flex items-center justify-end gap-3 border-t border-[var(--line)] pt-3 text-[10.5px] text-[var(--ink-mute)]">
      <span>{counts.words} words</span>
      <span aria-hidden>·</span>
      <span>{counts.chars} characters</span>
    </div>
  );
}
