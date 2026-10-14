/**
 * Server side of subtasks: one guarded write path shared by the MCP
 * `subtasks_write` tool and `POST /api/nodes/:id/subtasks`.
 *
 * The list lives on `node.data.subtasks[]` (see the contract module for
 * why), so a write is a read-modify-write of `data`. It is guarded by
 * `updated_at` exactly like `toggle_checklist_item`: when the caller pinned
 * `if_updated_at` we honour it strictly (their read is the contract); when
 * they did not, a lost race is retried a few times against a fresh read,
 * because "toggle subtask s3" is unambiguous whatever else changed on the
 * node — a concurrent title edit or attachment must not cost the agent a
 * round-trip, and must not be clobbered either (the guard is what stops
 * the whole-`data` patch from overwriting the other writer's keys).
 */
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import {
  applySubtaskOp,
  readSubtasks,
  withSubtasks,
  type Subtask,
  type SubtaskOp,
} from "@bcontext-dev/contract/subtasks";
import { ConflictError, type Storage } from "@/lib/storage";

export class SubtaskError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid" | "wrong_kind",
    message: string,
  ) {
    super(message);
    this.name = "SubtaskError";
  }
}

/** Kinds that carry work: the only ones that can hold subtasks. */
export const SUBTASK_KINDS: ReadonlySet<KnowledgeNode["kind"]> = new Set(["task", "bug"]);

function assertSubtaskKind(node: Pick<KnowledgeNode, "kind">): void {
  if (!SUBTASK_KINDS.has(node.kind)) {
    throw new SubtaskError(
      "wrong_kind",
      `subtasks belong to task or bug nodes; this node is a ${node.kind}. Put steps for a ${node.kind} in its body as \`- [ ]\` items instead.`,
    );
  }
}

export interface SubtaskWriteResult {
  before: KnowledgeNode;
  node: KnowledgeNode;
  subtasks: Subtask[];
  subtask: Subtask | null;
  changed: boolean;
  summary: string;
}

const RETRIES_WHEN_UNPINNED = 4;

/**
 * Applies one `SubtaskOp` with the guard described above. Throws
 * `SubtaskError` for a missing node or a non-task kind, and the storage
 * `ConflictError` when a pinned `ifUpdatedAt` no longer matches.
 */
export async function writeSubtaskOp(
  storage: Storage,
  nodeId: string,
  op: SubtaskOp,
  opts: { ifUpdatedAt?: string } = {},
): Promise<SubtaskWriteResult> {
  for (let attempt = 0; ; attempt++) {
    const before = await storage.getNode(nodeId);
    if (!before) throw new SubtaskError("not_found", `node not found: ${nodeId}`);
    assertSubtaskKind(before);
    const result = applySubtaskOp(readSubtasks(before.data), op);
    if (!result.ok) throw new SubtaskError("invalid", result.error);
    if (!result.changed) {
      return { before, node: before, subtasks: result.subtasks, subtask: result.subtask, changed: false, summary: result.summary };
    }
    const guard = opts.ifUpdatedAt ?? before.updated_at;
    try {
      const node = await storage.updateNode(
        nodeId,
        { data: withSubtasks(before.data, result.subtasks) },
        { ifUpdatedAt: guard },
      );
      if (!node) throw new SubtaskError("not_found", `node not found: ${nodeId}`);
      return { before, node, subtasks: result.subtasks, subtask: result.subtask, changed: true, summary: result.summary };
    } catch (err) {
      if (err instanceof ConflictError && !opts.ifUpdatedAt && attempt < RETRIES_WHEN_UNPINNED) {
        continue; // someone else wrote between our read and write — re-read and re-apply
      }
      throw err;
    }
  }
}
