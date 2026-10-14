import { InputRule, Node, mergeAttributes } from "@tiptap/core";

/**
 * Callout block — the editor form of GFM alerts (`> [!NOTE]` …). Serialized
 * back to that syntax by the turndown rule in lib/markdown.ts, so the body
 * on disk stays plain Markdown any renderer understands.
 *
 * Typing `> ` first creates a normal blockquote (StarterKit's input rule
 * wins that race); typing `[!note] ` (any known kind) as the first thing
 * inside it converts the blockquote into a callout. /note inserts one
 * directly.
 */

const CALLOUT_INPUT_REGEX =
  /^\[!(note|tip|important|warning|caution)\]\s$/i;

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "paragraph+",
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: "note",
        parseHTML: (el) => el.getAttribute("data-callout") || "note",
        renderHTML: (attrs) => ({ "data-callout": attrs.kind as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "callout" }),
      0,
    ];
  },

  addInputRules() {
    const calloutType = this.type;
    return [
      new InputRule({
        find: CALLOUT_INPUT_REGEX,
        handler: ({ state, range, match, chain }) => {
          const $from = state.selection.$from;
          const bqDepth = $from.depth - 1;
          if (bqDepth < 1) return;
          if ($from.node(bqDepth).type.name !== "blockquote") return;
          const pos = $from.before(bqDepth);
          const kind = (match[1] ?? "note").toLowerCase();
          chain()
            .deleteRange(range)
            .command(({ tr }) => {
              tr.setNodeMarkup(pos, calloutType, { kind });
              return true;
            })
            .run();
        },
      }),
    ];
  },
});
