/**
 * What NEXO does right after a node is written — the one hook both storage
 * backends call, so REST, MCP, connectors and the chat tools all get it for
 * free without each write path remembering to.
 *
 *   1. entity linking (no LLM): `references` edges to entities the text names;
 *   2. contradiction scan (LLM, in the worker): docs, decisions and ADRs
 *      whose text changed are queued, debounced per node.
 *
 * Fire-and-forget by contract. The write has already succeeded when this
 * runs; nothing here may throw into it, slow it down, or be awaited by it.
 * Every failure is logged and dropped.
 */
import { log } from "@bcontext-dev/contract/log";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { Storage } from "@/lib/storage";

export interface AfterNodeWriteOpts {
  created: boolean;
  /** Title or body changed (metadata-only updates skip both steps). */
  contentChanged: boolean;
}

/** The awaited form, for tests and for callers that want the outcome. */
export async function runAfterNodeWrite(
  storage: Storage,
  node: KnowledgeNode,
  opts: AfterNodeWriteOpts,
): Promise<{ linked: string[]; scan_enqueued: boolean }> {
  const out = { linked: [] as string[], scan_enqueued: false };
  if (!opts.created && !opts.contentChanged) return out;

  try {
    const { linkEntities } = await import("./entity-linker");
    out.linked = (await linkEntities(storage, node)).linked;
  } catch (err) {
    log.warn("nexo.after_write.entity_linking_failed", {
      workspace_id: storage.workspace.id,
      node_id: node.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (storage.backend === "supabase") {
    try {
      const { CONTRADICTION_KINDS, enqueueContradictionScan } = await import("./contradictions");
      if (CONTRADICTION_KINDS.includes(node.kind)) {
        const id = await enqueueContradictionScan({ workspaceId: storage.workspace.id, nodeId: node.id });
        out.scan_enqueued = id !== null;
      }
    } catch (err) {
      log.warn("nexo.after_write.enqueue_failed", {
        workspace_id: storage.workspace.id,
        node_id: node.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Fire-and-forget form for the write path: never throws, never delays the response. */
export function afterNodeWrite(storage: Storage, node: KnowledgeNode, opts: AfterNodeWriteOpts): void {
  void runAfterNodeWrite(storage, node, opts).catch((err) => {
    log.warn("nexo.after_write.failed", {
      workspace_id: storage.workspace.id,
      node_id: node.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
