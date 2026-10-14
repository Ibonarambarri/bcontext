/**
 * The network half of a kanban drag: PATCH the node through the API after the
 * board already moved the card. Browser-side (`fetch("/api/…")`, proxied to
 * the API); `optimistic.ts` owns the bookkeeping that keeps the card in place
 * until the answer lands.
 */
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

/** What the caller can act on: a toast per non-ok status, and the fresh node on ok. */
export type BoardMoveOutcome =
  | { status: "ok"; node: KnowledgeNode | null }
  | { status: "conflict" }
  | { status: "forbidden" }
  | { status: "error" };

/**
 * Persist a board move that was already applied visually at drop time.
 *
 * The visual change is NOT made here — the kanban list applies it
 * synchronously on drop. This only talks to the server and, on any failure,
 * invokes `rollback` so the caller can restore the canonical column and
 * toast. On success it returns the confirmed node (fresh `updated_at`) so
 * the caller can converge local state silently — no refetch, no
 * router.refresh, nothing visible.
 */
export async function persistBoardMove({
  workspace,
  nodeId,
  ifUpdatedAt,
  patch,
  rollback,
  request = fetch,
}: {
  workspace: WorkspaceAddress;
  nodeId: string;
  ifUpdatedAt: string;
  patch: Record<string, unknown>;
  rollback: () => void;
  request?: typeof fetch;
}): Promise<BoardMoveOutcome> {
  try {
    const response = await request(`/api/nodes/${encodeURIComponent(nodeId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: workspaceApiRef(workspace), if_updated_at: ifUpdatedAt, ...patch }),
    });
    if (response.ok) {
      let node: KnowledgeNode | null = null;
      try {
        node = ((await response.json()) as { node?: KnowledgeNode }).node ?? null;
      } catch {
        node = null;
      }
      return { status: "ok", node };
    }
    rollback();
    if (response.status === 409) return { status: "conflict" };
    if (response.status === 401 || response.status === 403) return { status: "forbidden" };
    return { status: "error" };
  } catch {
    rollback();
    return { status: "error" };
  }
}
