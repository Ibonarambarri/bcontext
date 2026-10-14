/**
 * Page context — what Nexo knows about where the user is standing.
 *
 * This is the difference between an assistant in a box and an assistant in the
 * app. The client sends the route, the view, the node on screen and the text
 * under the cursor; this module turns that into one system block.
 *
 * It is deliberately a *dynamic* block: it changes on every navigation, so it
 * must never be folded into the cached static prompt (see `prompt.ts`).
 */
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { PageContext } from "@bcontext-dev/contract/nexo/assistant";

/** Selections longer than this are truncated in the prompt (never in the tool). */
const MAX_SELECTION_CHARS = 4_000;

/**
 * Render the block. Returns null when the client sent nothing useful — Nexo
 * then behaves as a workspace-level assistant instead of pretending to know
 * where the user is.
 */
export function renderPageContextBlock(
  context: PageContext | null | undefined,
  openNode: KnowledgeNode | null,
): string | null {
  if (!context) return null;

  const lines: string[] = ["## Page context", ""];
  let known = false;

  if (context.route) {
    lines.push(`Route: \`${context.route}\``);
    known = true;
  }
  if (context.view) {
    const bits = [context.view.label ?? context.view.slug];
    if (context.view.renderer) bits.push(`${context.view.renderer} view`);
    lines.push(`Looking at: ${bits.join(" · ")}`);
    known = true;
  }

  if (openNode) {
    const where =
      context.open_node?.surface === "page"
        ? "open as a page"
        : "open in the floating panel";
    const block = context.open_node?.block_id
      ? `, focused on block \`#${context.open_node.block_id}\``
      : "";
    lines.push(
      `Open node: /n/${openNode.id} ("${openNode.title}"), ${where}${block}. Its full body is in the next system message.`,
    );
    known = true;
  } else if (context.open_node?.id) {
    // The id was sent but the node could not be read — out of reach, or gone.
    lines.push(
      `Open node: /n/${context.open_node.id}, not readable with your grants; do not guess its content.`,
    );
    known = true;
  }

  if (context.selection) {
    const { text, node_id, block_id } = context.selection;
    const truncated = text.length > MAX_SELECTION_CHARS;
    const shown = truncated ? text.slice(0, MAX_SELECTION_CHARS) : text;
    const origin = node_id
      ? ` (in /n/${node_id}${block_id ? `#${block_id}` : ""})`
      : "";
    lines.push(
      "",
      `Selected text${origin}${truncated ? " (truncated here, the document holds more)" : ""}:`,
      "```text",
      shown,
      "```",
      "",
      truncated
        ? "The selection is too long to edit verbatim: read the node and target a unique substring inside the selected range."
        : "When the user says \"this\", \"esto\", \"the selection\" or similar, they mean exactly that text. To change it, pass it verbatim as the `find` argument of `replace_in_block` (preferred, when you know the block) or `replace_in_node`, and touch nothing else.",
    );
    known = true;
  }

  if (context.visible_node_ids?.length) {
    lines.push(
      "",
      `On screen right now: ${context.visible_node_ids.map((id) => `/n/${id}`).join(", ")}.`,
    );
    known = true;
  }

  if (!known) return null;

  lines.push(
    "",
    context.surface === "page"
      ? "The user is in the full Nexo page, not looking at a node. Prefer opening what you cite with `open_node` so they can follow along. A bigger window is not a longer answer; the same brevity applies."
      : "The user is working in the app with Nexo open beside them. Keep answers short; open what you cite with `open_node` instead of pasting bodies.",
  );

  return lines.join("\n");
}
