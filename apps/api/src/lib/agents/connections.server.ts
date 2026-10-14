/**
 * The two writes that change an agent's access, kept apart from the vocabulary.
 *
 * The vocabulary (`AgentProvider`, `AgentRole`, `ROLE_SCOPES`) lives in
 * `@bcontext-dev/contract/agents/connections` because the web app renders it
 * in the browser; anything reaching for `supabase/admin` or the grant mirror
 * cannot live there. Callers: the agent connection, organization agent, OAuth
 * authorize and user token routes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncGrantFromAgentAccess } from "@/lib/auth/grant-sync";
import type { AgentProvider, AgentRole } from "@bcontext-dev/contract/agents/connections";
import type { Scope } from "@bcontext-dev/contract/auth/scopes";

/**
 * Inserts the agent, one `agent_workspace_access` row per workspace and the
 * mirrored grants; a failed access insert rolls the agent row back so no
 * orphan agent exists without access.
 */
export async function createAgentConnection(
  admin: SupabaseClient,
  input: {
    ownerUserId: string;
    name: string;
    provider: AgentProvider;
    providerLabel?: string | null;
    description?: string;
    workspaceIds: string[];
    role: AgentRole;
    scopes: Scope[];
  },
): Promise<string> {
  const { data: agent, error: agentError } = await admin
    .from("agents")
    .insert({
      owner_user_id: input.ownerUserId,
      name: input.name,
      provider: input.provider,
      provider_label:
        input.provider === "other" ? input.providerLabel?.trim() || "Other" : null,
      description: input.description ?? "",
    })
    .select("id")
    .single();
  if (agentError || !agent) {
    throw new Error(`agent create failed: ${agentError?.message ?? "no row"}`);
  }
  const agentId = agent.id as string;
  const { error: accessError } = await admin.from("agent_workspace_access").insert(
    input.workspaceIds.map((workspaceId) => ({
      agent_id: agentId,
      workspace_id: workspaceId,
      role: input.role,
      scopes: input.scopes,
      approved_by: input.ownerUserId,
    })),
  );
  if (accessError) {
    await admin.from("agents").delete().eq("id", agentId);
    throw new Error(`agent access create failed: ${accessError.message}`);
  }

  // A principal is per workspace, while the durable agent identity is global.
  const { error: principalError } = await admin.from("capability_principals").upsert(
    input.workspaceIds.map((workspaceId) => ({
      workspace_id: workspaceId,
      kind: "agent",
      source_type: "agent",
      source_id: agentId,
      display_name: input.name,
    })),
    { onConflict: "workspace_id,source_type,source_id" },
  );
  if (principalError) {
    await admin.from("agents").delete().eq("id", agentId);
    throw new Error(`agent principal create failed: ${principalError.message}`);
  }

  // `reinstate` because approving a connection *is* the act of granting access:
  // a tombstone from a previous connection of the same agent must not outlive
  // the approval a person just gave.
  await Promise.all(
    input.workspaceIds.map((workspaceId) =>
      syncGrantFromAgentAccess(workspaceId, agentId, input.scopes, { reinstate: true }),
    ),
  );
  return agentId;
}

/** Revokes the agent, all its workspace access, its tokens and the mirrored grants at once. */
export async function revokeAgentEverywhere(
  admin: SupabaseClient,
  agentId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await Promise.all([
    admin.from("agents").update({ status: "revoked" }).eq("id", agentId),
    admin.from("agent_workspace_access").update({ revoked_at: now }).eq("agent_id", agentId),
    admin.from("api_tokens").update({ revoked_at: now }).eq("agent_id", agentId),
    admin.from("oauth_access_tokens").update({ revoked_at: now }).eq("agent_id", agentId),
    admin.from("user_api_tokens").update({ revoked_at: now }).eq("agent_id", agentId),
    admin.from("capability_principals").update({ disabled_at: now }).eq("source_type", "agent").eq("source_id", agentId),
    // The grant table is authoritative, so "revoke everywhere" has to include
    // it. Without this line an agent cut off from its connection and its tokens
    // would still resolve a live grant — the one place revocation could have
    // silently missed.
    admin.from("workspace_grants").update({ revoked_at: now })
      .eq("principal_kind", "agent").eq("principal_id", agentId).is("revoked_at", null),
  ]);
}
