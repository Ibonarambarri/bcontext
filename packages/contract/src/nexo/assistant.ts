/**
 * Nexo assistant — the contract between the API and the web client.
 *
 * Nexo is the human-facing surface of the same intelligence `ask_nexo` gives
 * agents: it lives in the app (a launcher in the corner and a full page), it
 * knows where the user is, and it acts on the graph through tools.
 *
 * Three things have to agree across the two repos and therefore live here:
 *
 *   PageContext   what the client tells the server about where the user is
 *   NexoWireEvent the NDJSON line format the stream speaks
 *   tool names    so the client can label a step and act on a client tool
 *
 * Everything here is either a type or a pure zod schema — no imports beyond
 * zod, so the contract stays self-contained (`contract-is-self-contained.test.ts`).
 */
import { z } from "zod";

// -- Page context -------------------------------------------------------------

/** Where the conversation is happening. The page is the full Nexo section. */
export const NEXO_SURFACES = ["widget", "page"] as const;
export type NexoSurface = (typeof NEXO_SURFACES)[number];

/** How the open node is being shown — the floating panel or its own route. */
export const NODE_SURFACES = ["panel", "page"] as const;
export type NodeSurface = (typeof NODE_SURFACES)[number];

/**
 * The user's live text selection. `node_id` is the node the text was selected
 * in, which is what makes "rewrite this" resolvable: Nexo passes `text` as the
 * `find` argument of `replace_in_node` / `replace_in_block`.
 */
export const SelectionContextSchema = z
  .object({
    text: z.string().min(1).max(8_000),
    node_id: z.string().min(1).max(200).optional(),
    block_id: z.string().min(1).max(200).optional(),
  })
  .strict();
export type SelectionContext = z.infer<typeof SelectionContextSchema>;

export const OpenNodeContextSchema = z
  .object({
    id: z.string().min(1).max(200),
    block_id: z.string().min(1).max(200).nullish(),
    surface: z.enum(NODE_SURFACES).optional(),
  })
  .strict();
export type OpenNodeContext = z.infer<typeof OpenNodeContextSchema>;

export const ViewContextSchema = z
  .object({
    slug: z.string().min(1).max(200),
    label: z.string().max(200).optional(),
    renderer: z.string().max(60).optional(),
  })
  .strict();
export type ViewContext = z.infer<typeof ViewContextSchema>;

/**
 * Everything the client knows about the user's current position. Every field
 * is optional: Nexo degrades to a workspace-level assistant when the user is
 * somewhere with no node in sight.
 */
export const PageContextSchema = z
  .object({
    surface: z.enum(NEXO_SURFACES).optional(),
    /** Pathname only — never a full URL, never a query string with secrets. */
    route: z.string().max(500).optional(),
    view: ViewContextSchema.optional(),
    open_node: OpenNodeContextSchema.optional(),
    selection: SelectionContextSchema.optional(),
    /** Ids on screen right now (board cards, list rows, graph nodes). */
    visible_node_ids: z.array(z.string().min(1).max(200)).max(60).optional(),
  })
  .strict();
export type PageContext = z.infer<typeof PageContextSchema>;

// -- Wire format --------------------------------------------------------------

/**
 * One NDJSON line of a Nexo turn. Only what the UI renders is forwarded —
 * provider metadata, warnings and the noisier `text-start` /
 * `tool-input-delta` markers are dropped so the client parser stays a
 * `switch`.
 */
export type NexoWireEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: unknown;
    }
  | {
      type: "tool-error";
      toolCallId: string;
      toolName: string;
      error: string;
    }
  | { type: "finish" }
  | { type: "error"; message: string };

// -- Tools --------------------------------------------------------------------

/** Tools that only read. Safe to run without telling the user. */
export const NEXO_READ_TOOLS = [
  "read_node",
  "read_block",
  "search_nodes",
  "list_nodes",
  "list_tags",
] as const;

/**
 * Tools that change the graph. Every one of them returns `NexoWriteResult`, so
 * the client can offer a single undo affordance for all of them.
 */
export const NEXO_WRITE_TOOLS = [
  "edit_node",
  "replace_in_node",
  "replace_in_block",
  "create_node",
  "update_node_meta",
  "link_nodes",
  "add_reference",
  "remove_reference",
] as const;

/**
 * Tools with no server-side effect: they exist so the model can drive the UI.
 * The server resolves them immediately; the browser is what actually acts,
 * reading the `tool-call` line off the stream.
 */
export const NEXO_CLIENT_TOOLS = ["open_node", "open_view", "ask_user"] as const;

export type NexoReadTool = (typeof NEXO_READ_TOOLS)[number];
export type NexoWriteTool = (typeof NEXO_WRITE_TOOLS)[number];
export type NexoClientTool = (typeof NEXO_CLIENT_TOOLS)[number];
export type NexoToolName = NexoReadTool | NexoWriteTool | NexoClientTool;

export function isNexoWriteTool(name: string): name is NexoWriteTool {
  return (NEXO_WRITE_TOOLS as readonly string[]).includes(name);
}

export function isNexoClientTool(name: string): name is NexoClientTool {
  return (NEXO_CLIENT_TOOLS as readonly string[]).includes(name);
}

/** Payload of an `open_node` tool call. */
export interface OpenNodeToolInput {
  node_id: string;
  block_id?: string | null;
}

/** Payload of an `open_view` tool call. */
export interface OpenViewToolInput {
  view_slug: string;
}

/**
 * Payload of an `ask_user` tool call: a question with the answers worth
 * offering. The client renders the options as buttons and sends the chosen
 * one back as the next message, so a fork in the road costs one click instead
 * of a paragraph of clarification.
 */
export interface AskUserToolInput {
  question: string;
  options: { label: string; value?: string }[];
}

/** Most options worth putting in front of someone at once. */
export const NEXO_MAX_ASK_OPTIONS = 4;

/**
 * The shape every write tool returns.
 *
 * `before` is what makes undo possible client-side: the body as it was right
 * before the tool ran. It is omitted for very large documents (see
 * `NEXO_UNDO_MAX_CHARS`) and for writes that do not replace a body — in both
 * cases the client shows the change without an undo affordance.
 */
export interface NexoWriteResult {
  ok: boolean;
  id?: string;
  title?: string;
  kind?: string;
  /** Previous `content_md`, when small enough to carry and worth restoring. */
  before?: string | null;
  /** True when the tool created the node — undo means deleting it. */
  created?: boolean;
  /** One line for the trace, written by the model as `change_summary`. */
  summary?: string;
  error?: string;
}

/**
 * Above this, `before` is dropped rather than streamed back. 40k characters is
 * roughly a very long node; carrying more per tool call would cost more than
 * the undo is worth.
 */
export const NEXO_UNDO_MAX_CHARS = 40_000;

/** Human labels for the trace. Kept here so both surfaces agree. */
export const NEXO_TOOL_LABELS: Record<NexoToolName, string> = {
  read_node: "Reading node",
  read_block: "Reading block",
  search_nodes: "Searching the graph",
  list_nodes: "Listing nodes",
  list_tags: "Reading tags",
  edit_node: "Rewriting node",
  replace_in_node: "Editing node",
  replace_in_block: "Editing block",
  create_node: "Creating node",
  update_node_meta: "Updating node",
  link_nodes: "Linking nodes",
  add_reference: "Adding reference",
  remove_reference: "Removing reference",
  open_node: "Opening node",
  open_view: "Opening view",
  ask_user: "Asking",
};
