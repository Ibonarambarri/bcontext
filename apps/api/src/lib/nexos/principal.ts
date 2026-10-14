/**
 * A Nexo's identity as the permission system sees it: one `agents` row
 * (provider `nexo`), one `workspace_grants` row whose verbs come from the
 * Nexo's brain tools, and one `capability_principals` row that external
 * capabilities are granted to.
 *
 * Callers: `./lifecycle` (create, rename, brain tools, delete) and the
 * runtime, which acts as the Nexo through `nexoActor`.
 *
 * Deliberately NOT written: `agent_workspace_access`. That table is the front
 * door for external agent connections (Claude Code, Cursor…); a Nexo in it
 * would show up under "connected agents" and inherit their token flows. With
 * no access row the legacy fallback of `resolveGrant` denies, so the grant row
 * is the only way in and a failed grant write fails closed.
 *
 * Must not break: brain tools → scopes → verbs goes through
 * `syncGrantFromAgentAccess` / `verbsForScopes`, the same translation every
 * other agent gets, so there is one place that decides what `write` means.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { syncGrantFromAgentAccess } from "@/lib/auth/grant-sync";
import type { Actor } from "@/lib/auth/require";
import type { Scope } from "@bcontext-dev/contract/auth/scopes";
import type { Nexo, NexoBrainTools } from "@bcontext-dev/contract/nexos";

/**
 * The scopes a Nexo holds. `read` brings `chat:run` because a Nexo's whole job
 * is running the assistant; `write` adds `nodes:write`, which `verbsForScopes`
 * expands to write/delete/tags. A Nexo with neither still resolves to no verbs
 * at all — it can chat about nothing, which is what the switch says.
 */
export function scopesForBrainTools(tools: NexoBrainTools): Scope[] {
  const scopes: Scope[] = [];
  if (tools.read || tools.write) scopes.push("nodes:read", "chat:run");
  if (tools.write) scopes.push("nodes:write");
  return scopes;
}

/**
 * The actor the runtime acts as. `tokenId` is the agent id because there is
 * no token behind a Nexo and `audit_log.agent_token_id` is a uuid column:
 * audit rows then name the Nexo's agent, which is the honest answer.
 */
export function nexoActor(nexo: Pick<Nexo, "workspace_id" | "agent_id" | "brain_tools" | "created_by">): Extract<Actor, { kind: "agent" }> {
  return {
    kind: "agent",
    workspaceId: nexo.workspace_id,
    scopes: scopesForBrainTools(nexo.brain_tools),
    tokenId: nexo.agent_id,
    createdBy: nexo.created_by,
    agentId: nexo.agent_id,
  };
}

/**
 * Who answers for the agent row (`agents.owner_user_id` is required). The
 * person creating the Nexo when there is one; otherwise — the general Nexo
 * created lazily by an agent token — the workspace owner.
 */
export async function resolveNexoOwner(workspaceId: string, preferred: string | null): Promise<string> {
  if (preferred) return preferred;
  const { data, error } = await getSupabaseAdmin()
    .from("memberships")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data?.user_id) throw new Error("nexos.owner: workspace has no owner to answer for the Nexo");
  return String(data.user_id);
}

/**
 * Create the agent row, its capability principal and its grant. Rolls the
 * agent row back if the principal cannot be written, so no half identity is
 * left behind. Returns the agent id.
 */
export async function createNexoPrincipal(input: {
  workspaceId: string;
  ownerUserId: string;
  name: string;
  description: string;
  brainTools: NexoBrainTools;
}): Promise<string> {
  const admin = getSupabaseAdmin();
  const { data: agent, error: agentError } = await admin
    .from("agents")
    .insert({
      owner_user_id: input.ownerUserId,
      name: input.name,
      provider: "nexo",
      provider_label: null,
      description: input.description.slice(0, 240),
    })
    .select("id")
    .single();
  if (agentError || !agent) throw new Error(`nexos.principal: agent create failed: ${agentError?.message ?? "no row"}`);
  const agentId = String(agent.id);

  const { error: principalError } = await admin.from("capability_principals").upsert(
    {
      workspace_id: input.workspaceId,
      kind: "agent",
      source_type: "agent",
      source_id: agentId,
      display_name: input.name,
      disabled_at: null,
    },
    { onConflict: "workspace_id,source_type,source_id" },
  );
  if (principalError) {
    await admin.from("agents").delete().eq("id", agentId);
    throw new Error(`nexos.principal: capability principal failed: ${principalError.message}`);
  }

  // `reinstate`: creating the Nexo IS the act of granting it access.
  await syncGrantFromAgentAccess(input.workspaceId, agentId, scopesForBrainTools(input.brainTools), {
    reinstate: true,
  });
  return agentId;
}

/** Keep the identity in step with an edit: the display name everywhere, the verbs with the brain tools. */
export async function syncNexoPrincipal(input: {
  workspaceId: string;
  agentId: string;
  name?: string;
  description?: string;
  brainTools?: NexoBrainTools;
}): Promise<void> {
  const admin = getSupabaseAdmin();
  const identity: Record<string, unknown> = {};
  if (input.name !== undefined) identity.name = input.name;
  if (input.description !== undefined) identity.description = input.description.slice(0, 240);
  if (Object.keys(identity).length > 0) {
    const { error } = await admin.from("agents").update(identity).eq("id", input.agentId);
    if (error) throw new Error(`nexos.principal: agent update failed: ${error.message}`);
  }
  if (input.name !== undefined) {
    const { error } = await admin
      .from("capability_principals")
      .update({ display_name: input.name })
      .eq("workspace_id", input.workspaceId)
      .eq("source_type", "agent")
      .eq("source_id", input.agentId);
    if (error) throw new Error(`nexos.principal: principal rename failed: ${error.message}`);
  }
  if (input.brainTools) {
    // Not `reinstate`: if an admin revoked this Nexo's grant elsewhere,
    // flipping a brain-tools switch must not quietly restore it.
    await syncGrantFromAgentAccess(input.workspaceId, input.agentId, scopesForBrainTools(input.brainTools));
  }
}

/**
 * Take the identity's access away: grant revoked, capability principal
 * disabled (and its grants revoked), agent marked `revoked`. The agent row is
 * kept so past activity and audit rows keep resolving to the Nexo's name.
 */
export async function retireNexoPrincipal(workspaceId: string, agentId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  const at = new Date().toISOString();
  await syncGrantFromAgentAccess(workspaceId, agentId, null);
  const { data: principal } = await admin
    .from("capability_principals")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("source_type", "agent")
    .eq("source_id", agentId)
    .maybeSingle();
  if (principal?.id) {
    await admin
      .from("capability_grants")
      .update({ revoked_at: at })
      .eq("workspace_id", workspaceId)
      .eq("principal_id", principal.id)
      .is("revoked_at", null);
    await admin
      .from("capability_principals")
      .update({ disabled_at: at })
      .eq("workspace_id", workspaceId)
      .eq("id", principal.id);
  }
  const { error } = await admin.from("agents").update({ status: "revoked" }).eq("id", agentId);
  if (error) throw new Error(`nexos.principal: agent revoke failed: ${error.message}`);
}

/** Undo `createNexoPrincipal` when the Nexo row itself could not be written. */
export async function discardNexoPrincipal(workspaceId: string, agentId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin
    .from("workspace_grants")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("principal_kind", "agent")
    .eq("principal_id", agentId);
  await admin
    .from("capability_principals")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("source_type", "agent")
    .eq("source_id", agentId);
  await admin.from("agents").delete().eq("id", agentId);
}
