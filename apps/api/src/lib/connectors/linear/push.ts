/**
 * Linear push-side.
 *
 * When a Bcontext `task` node that was originally imported from Linear
 * (carries `data.linear_id`) has its `status` changed, push the new
 * state to Linear via `pushBcontextStatusToLinear` (`syncTaskToLinearIfLinked`).
 * Skip nodes without a `linear_id` and skip writes that don't change status.
 *
 * Wired into the node-update path in `src/app/api/nodes/[id]/route.ts`
 * with fire-and-forget semantics — the outbound mutation must never
 * delay the user-facing update.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSecret } from "@/lib/connectors/secrets";
import { pushBcontextStatusToLinear } from "@/lib/connectors/linear";
import { log } from "@bcontext-dev/contract/log";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";

interface InstallRow {
  id: string;
  secret_ref: string | null;
  status: string;
}

export async function syncTaskToLinearIfLinked(opts: {
  workspaceId: string;
  before: KnowledgeNode | null;
  after: KnowledgeNode;
}): Promise<{ pushed: boolean; reason?: string }> {
  const node = opts.after;
  if (node.kind !== "task") return { pushed: false, reason: "not_a_task" };

  const data = (node.data ?? {}) as Record<string, unknown>;
  const linearId = data.linear_id as string | undefined;
  if (!linearId) return { pushed: false, reason: "not_linked" };

  const statusChanged =
    opts.before == null ||
    (opts.before.status ?? null) !== (node.status ?? null);
  if (!statusChanged) return { pushed: false, reason: "no_status_change" };
  if (!node.status) return { pushed: false, reason: "no_status_set" };
  // Archiving is Bcontext housekeeping; Linear has no state for it.
  if (node.status === "archived") return { pushed: false, reason: "archived" };

  const sb = getSupabaseAdmin();
  const { data: installRow } = await sb
    .from("connector_installs")
    .select("id, secret_ref, status")
    .eq("workspace_id", opts.workspaceId)
    .eq("connector_id", "linear")
    .maybeSingle();
  const install = installRow as InstallRow | null;
  if (!install || install.status !== "active") {
    return { pushed: false, reason: "linear_not_installed" };
  }

  const token = await getSecret(install.secret_ref);
  if (!token) return { pushed: false, reason: "no_token" };

  const ok = await pushBcontextStatusToLinear({
    token,
    linearIssueId: linearId,
    status: node.status,
  });

  if (!ok) {
    log.warn("linear.push.failed", {
      workspace_id: opts.workspaceId,
      linear_id: linearId,
      status: node.status,
    });
    return { pushed: false, reason: "push_failed" };
  }

  log.info("linear.push.done", {
    workspace_id: opts.workspaceId,
    linear_id: linearId,
    status: node.status,
  });
  return { pushed: true };
}
