/**
 * GET /api/agents/connections?workspace=… — the Agents page: every agent
 * connected to the workspace with its role, scopes, live sessions and
 * capability grants, plus the approved capabilities/bundles the page offers.
 *
 * Session-cookie callers only (a token cannot list its peers), any member;
 * `can_manage` tells the web whether to render the edit controls. Membership
 * is checked by hand against `memberships` because the reads below go through
 * the admin client — nothing here relies on RLS.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { findWorkspaceByRef } from "@/lib/workspaces/resolve";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { withRoute } from "@/lib/route";

export const GET = withRoute(async (req: Request) => {
  const workspaceSlug = new URL(req.url).searchParams.get("workspace")?.trim();
  if (!workspaceSlug) {
    return Response.json({ error: "workspace_required" }, { status: 400 });
  }
  const supabase = getSupabaseForRequest(req);
  const { data: session } = await supabase.auth.getUser();
  if (!session.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const admin = getSupabaseAdmin();
  const workspace = await findWorkspaceByRef(workspaceSlug, "id, name, slug");
  if (!workspace) return Response.json({ error: "workspace_not_found" }, { status: 404 });
  const { data: membership } = await admin
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspace.id)
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (!membership) return Response.json({ error: "forbidden" }, { status: 403 });
  const canManage = ["owner", "admin"].includes(membership.role as string);

  // `client_name` is the MCP clientInfo the agent announced on connect; the
  // web matches it against its registry to pick the provider logo.
  const agentColumns = "id,owner_user_id,name,provider,provider_label,description,status,created_at,last_seen_at,client_name";
  const { data: accessRows, error } = await admin
    .from("agent_workspace_access")
    .select(`role,scopes,approved_at,agents:agent_id(${agentColumns})`)
    .eq("workspace_id", workspace.id)
    .is("revoked_at", null)
    .order("approved_at", { ascending: false });
  if (error) return Response.json({ error: "internal", message: error.message }, { status: 500 });

  type AgentRow = {
    id: string;
    owner_user_id: string;
    name: string;
    provider: string;
    provider_label: string | null;
    description: string;
    status: string;
    created_at: string;
    last_seen_at: string | null;
    client_name: string | null;
  };
  type AccessJoinRow = {
    role: string;
    scopes: string[];
    approved_at: string;
    agents: AgentRow | AgentRow[] | null;
  };
  type SessionRow = { agent_id: string; last_used_at: string | null };
  type AccessCountRow = { agent_id: string };
  type PrincipalRow = { id: string; source_id: string };
  type GrantRow = { principal_id: string; capability_id: string | null; bundle_id: string | null };
  const normalized = ((accessRows ?? []) as unknown as AccessJoinRow[]).flatMap((row: AccessJoinRow) => {
    const joined = row.agents;
    const agent = Array.isArray(joined) ? joined[0] : joined;
    return agent ? [{ access: row, agent }] : [];
  });
  const agentIds = normalized.map(({ agent }: { agent: AgentRow }) => agent.id);

  const [apiResult, oauthResult, userResult, accessResult, principalResult, capabilityResult, bundleResult] =
    agentIds.length === 0
      ? [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }]
      : await Promise.all([
          admin.from("api_tokens").select("agent_id,last_used_at").in("agent_id", agentIds).is("revoked_at", null),
          admin.from("oauth_access_tokens").select("agent_id,last_used_at").in("agent_id", agentIds).is("revoked_at", null),
          admin.from("user_api_tokens").select("agent_id,last_used_at").in("agent_id", agentIds).is("revoked_at", null),
          admin.from("agent_workspace_access").select("agent_id").in("agent_id", agentIds).is("revoked_at", null),
          admin.from("capability_principals").select("id,source_id").eq("workspace_id", workspace.id).eq("source_type", "agent").in("source_id", agentIds).is("disabled_at", null),
          admin.from("capabilities").select("id,title,provider,type").eq("workspace_id", workspace.id).eq("status", "approved").is("deleted_at", null).is("disabled_at", null),
          admin.from("capability_bundles").select("id,title").eq("workspace_id", workspace.id).eq("status", "approved"),
        ]);
  const apiTokens = (apiResult.data ?? []) as SessionRow[];
  const oauthTokens = (oauthResult.data ?? []) as SessionRow[];
  const userTokens = (userResult.data ?? []) as SessionRow[];
  const allAccess = (accessResult.data ?? []) as AccessCountRow[];
  const principals = (principalResult.data ?? []) as PrincipalRow[];
  const capabilities = capabilityResult.data ?? [];
  const bundles = bundleResult.data ?? [];

  const principalIds = principals.map((row: PrincipalRow) => row.id);
  const grants = principalIds.length > 0
    ? (await admin
        .from("capability_grants")
        .select("principal_id,capability_id,bundle_id")
        .in("principal_id", principalIds)
        .is("revoked_at", null)).data ?? []
    : [];
  const typedGrants = grants as GrantRow[];
  const principalByAgent = new Map(principals.map((row: PrincipalRow) => [row.source_id, row.id]));
  const sessions = [...apiTokens, ...oauthTokens, ...userTokens];

  const agents = normalized.map(({ access, agent }: { access: AccessJoinRow; agent: AgentRow }) => {
    const principalId = principalByAgent.get(agent.id);
    const agentGrants = principalId ? typedGrants.filter((grant: GrantRow) => grant.principal_id === principalId) : [];
    const agentSessions = sessions.filter((item) => item.agent_id === agent.id);
    return {
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      provider_label: agent.provider_label,
      description: agent.description,
      status: agent.status,
      role: access.role,
      scopes: access.scopes,
      created_at: agent.created_at,
      approved_at: access.approved_at,
      last_seen_at: agent.last_seen_at,
      client_name: agent.client_name ?? null,
      workspace_count: allAccess.filter((item: AccessCountRow) => item.agent_id === agent.id).length,
      session_count: agentSessions.length,
      capability_ids: agentGrants.flatMap((grant: GrantRow) => grant.capability_id ? [grant.capability_id] : []),
      bundle_ids: agentGrants.flatMap((grant: GrantRow) => grant.bundle_id ? [grant.bundle_id] : []),
      can_edit_identity: agent.owner_user_id === session.user.id,
    };
  });

  return Response.json({
    workspace,
    can_manage: canManage,
    agents,
    capabilities,
    bundles,
  });
});
