/**
 * Keeping `workspace_grants` in step with the tables that still own access.
 *
 * Grants started out as something that could only ever *narrow*:
 * `resolveGrant` intersected a grant row with the legacy `memberships` /
 * `agent_workspace_access` answer, because nothing wrote grants and a stale
 * row would otherwise have outlived the access it came from. Removing someone
 * from a workspace would have left their grant intact and their access alive.
 *
 * That safety net has a cost. Accepting an invitation has to write a
 * membership *as well as* a grant, or the intersection reduces the new grant
 * to nothing. Worse, if the membership role is narrower than the granted
 * verbs — a `viewer` beside a write grant — the result is read-only with no
 * error anywhere. Two sources of truth for one question, disagreeing
 * silently.
 *
 * So there is no intersection, and this module is what makes that safe: every
 * place that writes a membership or an agent connection mirrors it into the
 * grant table in the same breath. The legacy tables stay the front door for
 * now — the UI writes them, the invite flow writes them — but they stop being
 * a second, contradictory answer.
 *
 * Mirroring, not migrating. A principal with no grant row still resolves
 * through the legacy path, so nothing needed a backfill and nothing changes for
 * anyone until their access is next touched.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@bcontext-dev/contract/log";
import { verbsForRole, verbsForScopes, type Verb } from "./grants";

/**
 * Mirror a membership into the grant table.
 *
 * `role: null` means the membership was removed, which revokes the grant rather
 * than deleting it: who had access and when it was taken away is what an
 * incident review asks first.
 *
 * Reach is always `all` here. A role says what someone may *do*, never what
 * they may *see* — narrowing is a separate, deliberate act through
 * `grantAccess`, and this must never silently widen a reach someone chose.
 */
export async function syncGrantFromMembership(
  workspaceId: string,
  userId: string,
  role: string | null,
  options: SyncOptions = {},
): Promise<void> {
  await sync("user", workspaceId, userId, role === null ? null : [...verbsForRole(role)], options);
}

export interface SyncOptions {
  /**
   * Whether this write may bring a revoked grant back to life.
   *
   * `false` (the default) for a role change: an admin who revoked someone
   * through `revokeAccess` did not touch `memberships`, so that person is still
   * on the members screen. Re-picking their role there — even the role they
   * already had — must not quietly restore access nobody re-granted.
   *
   * `true` for a genuine admission: accepting an invitation, or creating the
   * workspace. Those *are* the act of granting access, so an old tombstone
   * should not outlive them.
   */
  reinstate?: boolean;
}

/**
 * Mirror an agent's workspace connection into the grant table.
 *
 * `scopes: null` means the connection was revoked. Note the asymmetry with
 * memberships: an agent's verbs come from the scopes its connection was
 * approved for, not from a role.
 */
export async function syncGrantFromAgentAccess(
  workspaceId: string,
  agentId: string,
  scopes: readonly string[] | null,
  options: SyncOptions = {},
): Promise<void> {
  await sync(
    "agent",
    workspaceId,
    agentId,
    scopes === null ? null : [...verbsForScopes(scopes)],
    options,
  );
}

async function sync(
  kind: "user" | "agent",
  workspaceId: string,
  principalId: string,
  verbs: Verb[] | null,
  options: SyncOptions = {},
): Promise<void> {
  // Everything below records its own failure. supabase-js resolves PostgREST
  // and transport errors into `{ error }` instead of throwing, so a try/catch
  // around these calls would never fire — an earlier version had exactly that,
  // and a failed revoke would have left access live with nothing in the log.
  const fail = (op: string, message: string) => {
    log.error("grant_sync.failed", {
      workspace_id: workspaceId,
      principal_kind: kind,
      principal_id: principalId,
      op,
      error: message,
    });
  };

  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch (err) {
    // Also inside the contract: this must never fail the caller's write.
    fail("client", err instanceof Error ? err.message : String(err));
    return;
  }

  if (verbs === null) {
    const { error } = await admin
      .from("workspace_grants")
      .update({ revoked_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("principal_kind", kind)
      .eq("principal_id", principalId)
      .is("revoked_at", null);
    if (error) fail("revoke", error.message);
    return;
  }

  const { data: existing, error: readError } = await admin
    .from("workspace_grants")
    .select("id, reach, revoked_at")
    .eq("workspace_id", workspaceId)
    .eq("principal_kind", kind)
    .eq("principal_id", principalId)
    .maybeSingle();
  if (readError) {
    fail("read", readError.message);
    return;
  }

  // A revoked grant stays revoked unless this write is an admission. See
  // `SyncOptions.reinstate`.
  if (existing?.revoked_at && !options.reinstate) return;

  const { error } = await admin.from("workspace_grants").upsert(
    {
      workspace_id: workspaceId,
      principal_kind: kind,
      principal_id: principalId,
      verbs,
      // An existing reach — someone deliberately narrowed to finanzas —
      // survives untouched. A role change is not a statement about what
      // somebody should see.
      reach: existing?.reach ?? { type: "all" },
      revoked_at: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,principal_kind,principal_id" },
  );
  if (error) fail("upsert", error.message);
}
