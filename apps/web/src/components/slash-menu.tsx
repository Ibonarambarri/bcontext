"use client";

/**
 * The `/` block-insert menu of the TipTap editor (`editor.tsx` registers it
 * as an extension). Typing `/` at the start of an empty paragraph opens a
 * list of block commands from `@/lib/slash-items` (headings, lists, callouts,
 * …); each item runs its own `command({ editor, range })`, which is what
 * deletes the `/query` and inserts the block. Same rendering mechanics as
 * `mention-menu.tsx`: TipTap `ReactRenderer` into a body-level container
 * positioned by hand, because the contenteditable would swallow the popup.
 */

import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionOptions,
  type SuggestionProps,
} from "@tiptap/suggestion";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type ForwardedRef,
} from "react";
import { Card, Kbd } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import {
  filterSlashItems,
  type SlashItem,
} from "@/lib/slash-items";

type ListHandle = { onKeyDown: (event: KeyboardEvent) => boolean };
type ListProps = SuggestionProps<SlashItem>;

const SlashMenuList = forwardRef(function SlashMenuList(
  { items, command }: ListProps,
  ref: ForwardedRef<ListHandle>,
) {
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    setSelected(0);
  }, [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (items.length === 0) return false;
      if (event.key === "ArrowDown") {
        setSelected((s) => (s + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelected((s) => (s + items.length - 1) % items.length);
        return true;
      }
      if (event.key === "Enter") {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <Card className="fade-in min-w-[260px] rounded-2xl p-3 text-xs text-[var(--ink-mute)] shadow-lg">
        No matches
      </Card>
    );
  }

  return (
    <Card
      role="listbox"
      aria-label="Insert block"
      className="fade-in min-w-[300px] max-w-[320px] overflow-hidden rounded-2xl p-1 shadow-lg"
    >
      <div className="mono flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11px] text-[var(--ink-mute)]">
        / <span className="text-[var(--ink-2)]">insert</span>
      </div>
      {items.map((item, i) => {
        const Icon = item.icon;
        return (
          <button
            key={item.title}
            type="button"
            role="option"
            aria-selected={i === selected}
            onMouseEnter={() => setSelected(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              command(item);
            }}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
              i === selected
                ? "bg-[var(--paper-3)] text-[var(--ink)]"
                : "text-[var(--ink-2)]",
            )}
          >
            <Icon
              size={15}
              className={cn(
                "shrink-0",
                i === selected ? "text-[var(--accent)]" : "text-[var(--ink-mute)]",
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] text-[var(--ink)]">{item.title}</div>
              <div className="mono text-[10.5px] text-[var(--ink-mute)]">
                {item.description}
              </div>
            </div>
            {item.shortcut && (
              <Kbd className="shrink-0">
                <Kbd.Content>{item.shortcut}</Kbd.Content>
              </Kbd>
            )}
          </button>
        );
      })}
    </Card>
  );
});

function position(el: HTMLElement, rect: DOMRect | null | undefined) {
  if (!rect) return;
  el.style.top = `${rect.bottom + window.scrollY + 6}px`;
  el.style.left = `${rect.left + window.scrollX}px`;
}

const suggestionConfig: Omit<SuggestionOptions<SlashItem>, "editor"> = {
  char: "/",
  startOfLine: false,
  allowSpaces: false,
  // Only at the start of a paragraph: a `/` inside prose (URLs, "and/or")
  // is text, not a command.
  allow({ state, range }) {
    const $from = state.doc.resolve(range.from);
    return $from.parentOffset === 0 && $from.parent.type.name === "paragraph";
  },
  items({ query }) {
    return filterSlashItems(query);
  },
  command({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) {
    props.command({ editor, range });
  },
  render: () => {
    let renderer: ReactRenderer<ListHandle, ListProps> | null = null;
    let container: HTMLDivElement | null = null;

    return {
      onStart(props) {
        renderer = new ReactRenderer(SlashMenuList, {
          props,
          editor: props.editor,
        });
        container = document.createElement("div");
        container.style.position = "absolute";
        container.style.zIndex = "50";
        container.appendChild(renderer.element);
        document.body.appendChild(container);
        position(container, props.clientRect?.());
      },
      onUpdate(props) {
        renderer?.updateProps(props);
        if (container) position(container, props.clientRect?.());
      },
      onKeyDown(props: SuggestionKeyDownProps) {
        if (props.event.key === "Escape") {
          container?.remove();
          renderer?.destroy();
          renderer = null;
          container = null;
          return true;
        }
        return renderer?.ref?.onKeyDown(props.event) ?? false;
      },
      onExit() {
        container?.remove();
        renderer?.destroy();
        renderer = null;
        container = null;
      },
    };
  },
};

const slashPluginKey = new PluginKey("slashSuggestion");

/** TipTap extension: `/` suggestion → block insert. No options; the item list is static. */
export const SlashMenu = Extension.create({
  name: "slashMenu",
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: slashPluginKey,
        ...suggestionConfig,
      }),
    ];
  },
});
