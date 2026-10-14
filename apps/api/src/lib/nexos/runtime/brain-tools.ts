/**
 * Narrow the Nexo assistant's brain tools (`buildNexoTools`) to what one Nexo
 * may use: its `brain_tools` switches, and — in a headless run — without the
 * client-only tools, which only make sense with a person watching a browser.
 *
 * Callers: `./runner` (background runs) and `@/lib/nexo/assistant/turn` (a
 * specialist's chat, which keeps the client tools).
 *
 * Must not break: the lists are allowlists. A tool added to `buildNexoTools`
 * and not classified here is dropped, never handed to a Nexo whose switches
 * did not consider it. Scoped storage still enforces the grant underneath;
 * this filter is what keeps the model from even trying.
 */
import type { NexoBrainTools } from "@bcontext-dev/contract/nexos";

export const BRAIN_READ_TOOLS = ["search_nodes", "list_nodes", "list_tags", "read_node", "read_block"] as const;
export const BRAIN_WRITE_TOOLS = [
  "edit_node",
  "replace_in_node",
  "replace_in_block",
  "create_node",
  "update_node_meta",
  "link_nodes",
  "add_reference",
  "remove_reference",
] as const;
/** No server effect: the browser acts on them. Meaningless without one. */
export const BRAIN_CLIENT_TOOLS = ["open_node", "open_view", "ask_user"] as const;

const READ = new Set<string>(BRAIN_READ_TOOLS);
const WRITE = new Set<string>(BRAIN_WRITE_TOOLS);
const CLIENT = new Set<string>(BRAIN_CLIENT_TOOLS);

export function filterBrainTools<T extends Record<string, unknown>>(
  tools: T,
  brain: NexoBrainTools,
  opts: { headless: boolean },
): Partial<T> {
  // `write` brings `nodes:read` with it (see `scopesForBrainTools`): writing
  // blind is not a mode we offer.
  const canRead = brain.read || brain.write;
  const out: Partial<T> = {};
  for (const [name, t] of Object.entries(tools)) {
    const keep =
      (READ.has(name) && canRead) ||
      (WRITE.has(name) && brain.write) ||
      (CLIENT.has(name) && canRead && !opts.headless);
    if (keep) (out as Record<string, unknown>)[name] = t;
  }
  return out;
}

/** True for tools whose call changes something (used to tell a no-op run from a quiet one). */
export function isSideEffectTool(name: string): boolean {
  return WRITE.has(name) || name === "reply" || name === "escalate" || name === "capability_call";
}

/** Node reads whose result is a node or a list of nodes (see `scopedStorage`'s classification). */
const NODE_READS = new Set(["getNode", "listNodes", "listNodeSummaries", "listNodeContext"]);
/** Mutations naming an existing node by id in their first argument. */
const NODE_ID_WRITES = new Set(["updateNode", "deleteNode", "setNodeTags"]);
/** Edge mutations: `{ from_node, to_node }`. */
const EDGE_WRITES = new Set(["createEdge", "deleteEdge"]);

const isCredential = (row: unknown): boolean =>
  Boolean(row && typeof row === "object" && (row as { kind?: unknown }).kind === "credential");

/**
 * `storage` with every `credential` node removed: not found on `getNode`,
 * absent from lists, and refused as the subject of a write or an edge.
 *
 * Why on top of `maskCredentials`: masking hides a credential's values but
 * still shows the node — its title, its non-secret fields, the fact that a
 * "Stripe live key" exists and where. A headless run has no use for any of
 * that (external tools reach their secrets through the capability gateway,
 * never through the brain), and a run fed by a Slack message must not be
 * able to read it back into a reply. Hiding the kind entirely is the only
 * shape a prompt injection cannot talk its way around.
 *
 * Callers: `./runner` for every background run. Retrieval needs nothing
 * extra: credential nodes are never embedded (`@/lib/rag/embed`).
 */
export function hideCredentialNodes<S extends object>(storage: S): S {
  return new Proxy(storage, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      const call = (args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args);
      const getNode = (id: unknown) =>
        (Reflect.get(target, "getNode", receiver) as (id: unknown) => Promise<unknown>).call(target, id);

      if (NODE_READS.has(prop)) {
        return async (...args: unknown[]) => {
          const out = await call(args);
          if (Array.isArray(out)) return out.filter((row) => !isCredential(row));
          return isCredential(out) ? null : out;
        };
      }
      if (NODE_ID_WRITES.has(prop) || EDGE_WRITES.has(prop)) {
        return async (...args: unknown[]) => {
          const first = args[0];
          const ids = EDGE_WRITES.has(prop)
            ? [(first as { from_node?: unknown })?.from_node, (first as { to_node?: unknown })?.to_node]
            : [first];
          for (const id of ids) {
            if (typeof id === "string" && isCredential(await getNode(id))) {
              throw new Error("node not found");
            }
          }
          return call(args);
        };
      }
      return value;
    },
  });
}
