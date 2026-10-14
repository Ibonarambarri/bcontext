"use client";

/**
 * The `@` mention menu of the TipTap editor (`editor.tsx` registers it as an
 * extension). Typing `@` opens a floating list of the workspace's nodes,
 * ranked by the contract's `searchMentions`; picking one inserts the node's
 * title as a link to `/w/<org>/<ws>/n/<id>` — a mention IS a link, which is
 * what the backlink index reads. Candidates come from the editor's props
 * (`getCandidates`), not from a fetch, so the menu is instant.
 *
 * The list is rendered with TipTap's `ReactRenderer` into a container
 * appended to `document.body` and positioned by hand: the editor's own DOM
 * is contenteditable and would swallow the popup's events.
 */

import { Extension } from "@tiptap/core";
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
import { Card, Chip } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import {
  searchMentions,
  type MentionCandidate,
} from "@bcontext-dev/contract/mention-search";
import { workspacePath, type WorkspaceAddress } from "@/web/workspace-url";

type ListHandle = { onKeyDown: (event: KeyboardEvent) => boolean };
type ListProps = SuggestionProps<MentionCandidate>;

const MentionMenuList = forwardRef(function MentionMenuList(
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
      if (event.key === "Enter" || event.key === "Tab") {
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
        No matching nodes
      </Card>
    );
  }

  return (
    <Card
      role="listbox"
      aria-label="Mention a node"
      className="fade-in max-h-[280px] min-w-[280px] max-w-[360px] overflow-y-auto rounded-2xl p-1 text-sm shadow-lg"
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === selected}
          title={item.snippet || item.title}
          onMouseEnter={() => setSelected(i)}
          onMouseDown={(e) => {
            // preventDefault keeps the editor's selection (and the
            // suggestion range) alive through the click.
            e.preventDefault();
            command(item);
          }}
          className={cn(
            "flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors",
            i === selected
              ? "bg-[var(--paper-3)] text-[var(--ink)]"
              : "text-[var(--ink-2)]",
          )}
        >
          <span className="flex w-full items-center gap-2">
            <span className="truncate text-[13px] text-[var(--ink)]">
              {item.title}
            </span>
            <Chip size="sm" variant="soft" className="ml-auto shrink-0">
              <Chip.Label className="text-[9px] uppercase tracking-wide">
                {item.kind}
              </Chip.Label>
            </Chip>
          </span>
          {item.snippet && (
            <span className="line-clamp-1 text-[11px] text-[var(--ink-mute)]">
              {item.snippet}
            </span>
          )}
        </button>
      ))}
    </Card>
  );
});

function position(el: HTMLElement, rect: DOMRect | null | undefined) {
  if (!rect) return;
  el.style.top = `${rect.bottom + window.scrollY + 6}px`;
  el.style.left = `${rect.left + window.scrollX}px`;
}

export type MentionMenuOptions = {
  workspace: WorkspaceAddress;
  /** Read at query time, so the list follows the workspace's nodes without a re-configure. */
  getCandidates: () => MentionCandidate[];
};

const mentionPluginKey = new PluginKey("mentionSuggestion");

/** TipTap extension: `@` suggestion → node link. Configure with `MentionMenuOptions`. */
export const MentionMenu = Extension.create<MentionMenuOptions>({
  name: "mentionMenu",
  addOptions() {
    return {
      workspace: { org: "", slug: "" },
      getCandidates: () => [],
    };
  },
  addProseMirrorPlugins() {
    const opts = this.options;
    const suggestion: Omit<SuggestionOptions<MentionCandidate>, "editor"> = {
      char: "@",
      allowSpaces: false,
      items({ query }) {
        return searchMentions(query, opts.getCandidates());
      },
      command({ editor, range, props }) {
        const href = workspacePath(opts.workspace, `n/${props.id}`);
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent([
            {
              type: "text",
              text: props.title,
              marks: [{ type: "link", attrs: { href } }],
            },
            { type: "text", text: " " },
          ])
          .run();
      },
      render: () => {
        let renderer: ReactRenderer<ListHandle, ListProps> | null = null;
        let container: HTMLDivElement | null = null;

        return {
          onStart(props) {
            renderer = new ReactRenderer(MentionMenuList, {
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
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: mentionPluginKey,
        ...suggestion,
      }),
    ];
  },
});
