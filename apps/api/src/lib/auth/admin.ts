/**
 * Granting and revoking access.
 *
 * This is the piece that makes the permission model a product rather than
 * infrastructure: until something writes `workspace_grants`, the table is empty,
 * every reach resolves to `all`, and nobody can be narrowed to anything.
 *
 * The safeguards live here rather than in the routes that call it. A rule
 * enforced at the call site is a rule that the second call site forgets — and
 * with granting, forgetting once means an agent can widen itself and then do
 * anything. Everything below refuses by default and explains why in the error,
 * because the caller is often an agent that has to relay the reason to a person.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { appendAudit } from "@/lib/audit";
import { log } from "@bcontext-dev/contract/log";
import {
  canGrant,
  isSelfGrant,
  type Grant,
  type PrincipalKind,
  type Reach,
  type Verb,
} from "./grants";

export class GrantError extends Error {
  constructor(
    readonly code: "forbidden" | "not_found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "GrantError";
  }
}

export interface PrincipalRef {
  kind: PrincipalKind;
  id: string;
}

export interface GrantRow {
  principal: PrincipalRef;
  verbs: Verb[];
  reach: Reach;
  expires_at: string | null;
  granted_by: string | null;
  updated_at: string;
}

/**
 * Who can reach this workspace, people and agents in one list.
 *
 * Deliberately one list: an administrator deciding who sees what should not
 * have to hold two mental models. The permission model already treats them
 * identically, and the screen that eventually renders this should too.
 */
export async function listAccess(grant: Grant): Promise<GrantRow[]> {
  requireAdmin(grant);
  const admin = getSupabaseAdmin();

  const { data, error } = await admin
    .from("workspace_grants")
    .select("principal_kind, principal_id, verbs, reach, expires_at, granted_by, updated_at")
    .eq("workspace_id", grant.workspaceId)
    .is("revoked_at", null);
  if (error) throw new GrantError("invalid", `listAccess: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    principal: {
      kind: row.principal_kind as PrincipalKind,
      id: row.principal_id as string,
    },
    verbs: (row.verbs as Verb[]) ?? [],
    reach: row.reach as Reach,
    expires_at: row.expires_at as string | null,
    granted_by: row.granted_by as string | null,
    updated_at: row.updated_at as string,
  }));
}

export interface GrantInput {
  principal: PrincipalRef;
  verbs: Verb[];
  reach: Reach;
  /** ISO timestamp. A grant that expires is one nobody has to remember to remove. */
  expiresAt?: string | null;
}

/**
 * Grant or replace one principal's access to a workspace.
 *
 * `unique (workspace_id, principal_kind, principal_id)` means this is an upsert
 * by construction: a principal holds one grant per workspace, never a pile to
 * be combined. That is what keeps "what can this person actually do here"
 * answerable by looking at one row.
 */
export async function grantAccess(
  granter: Grant,
  input: GrantInput,
): Promise<GrantRow> {
  requireAdmin(granter);

  if (isSelfGrant(granter, input.principal)) {
    // Self-granting is the shortest path from "an agent was compromised" to
    // "an agent owns the workspace", and it has no legitimate use: whoever set
    // up the agent could have given it those verbs directly.
    throw new GrantError("forbidden", "a principal cannot grant to itself");
  }

  const allowed = canGrant(granter, input.verbs, input.reach);
  if (!allowed.ok) throw new GrantError("forbidden", allowed.reason);

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("workspace_grants")
    .upsert(
      {
        workspace_id: granter.workspaceId,
        principal_kind: input.principal.kind,
        principal_id: input.principal.id,
        verbs: input.verbs,
        reach: input.reach,
        expires_at: input.expiresAt ?? null,
        granted_by: granter.principal.id,
        revoked_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,principal_kind,principal_id" },
    )
    .select("principal_kind, principal_id, verbs, reach, expires_at, granted_by, updated_at")
    .single();

  if (error) throw new GrantError("invalid", `grantAccess: ${error.message}`);

  await audit(granter, "grant", input.principal, {
    verbs: input.verbs,
    reach: input.reach,
    expires_at: input.expiresAt ?? null,
  });

  return {
    principal: input.principal,
    verbs: (data.verbs as Verb[]) ?? [],
    reach: data.reach as Reach,
    expires_at: data.expires_at as string | null,
    granted_by: data.granted_by as string | null,
    updated_at: data.updated_at as string,
  };
}

/**
 * Revoke a principal's access.
 *
 * Sets `revoked_at` rather than deleting the row: who had access, granted by
 * whom, and when it was taken away is the question an incident review asks
 * first, and a deleted row cannot answer it.
 */
export async function revokeAccess(
  granter: Grant,
  principal: PrincipalRef,
): Promise<void> {
  requireAdmin(granter);

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("workspace_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("workspace_id", granter.workspaceId)
    .eq("principal_kind", principal.kind)
    .eq("principal_id", principal.id)
    .is("revoked_at", null)
    .select("principal_id");

  if (error) throw new GrantError("invalid", `revokeAccess: ${error.message}`);
  if (!data || data.length === 0) {
    throw new GrantError("not_found", "no active grant for that principal");
  }

  await audit(granter, "revoke", principal, {});
}

function requireAdmin(grant: Grant): void {
  if (!grant.verbs.includes("admin")) {
    throw new GrantError("forbidden", 'this principal lacks the "admin" permission in this workspace');
  }
}

/**
 * Every grant and revocation goes to the audit log with the actor.
 *
 * "An agent did it" is not an answer anyone can act on. The row records which
 * agent and on whose behalf, so a review can tell an automated grant from a
 * person's, and find the human at the end of the chain either way.
 */
async function audit(
  granter: Grant,
  action: "grant" | "revoke",
  target: PrincipalRef,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await appendAudit({
      workspaceId: granter.workspaceId,
      action: `access.${action}`,
      actorType: granter.principal.kind === "agent" ? "agent" : "user",
      actorId: granter.principal.id,
      input: { target_kind: target.kind, target_id: target.id, ...details },
    });
  } catch (err) {
    // An audit failure must not silently swallow the fact that access changed.
    log.error("access.audit_failed", {
      workspace_id: granter.workspaceId,
      action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
