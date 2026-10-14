/**
 * One person inside an organization, as its administrator needs to see them.
 *
 * The roster answers "who is here". This answers the question that follows —
 * what may this person do, what have they connected, and what are they
 * consuming — at once on purpose: an agent consumes on behalf of the person
 * who owns it, so the meters only make sense beside the agents.
 *
 * Everything here runs on the service-role client; the caller must already
 * have passed `gateOrgAdmin`.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  USAGE_KINDS,
  type OrgMemberAgent,
  type OrgMemberDetail,
  type OrgMemberMeter,
} from "@bcontext-dev/contract/organizations";
import { OrgAdminError, getOrgAdminDetail } from "./admin";
import { getOrgUsageTotals, type OrgUsageTotals } from "./meters";

/**
 * The whole person, in one read.
 *
 * The roster is re-read rather than re-derived: `getOrgAdminDetail` is the one
 * place that knows how an owner's reach differs from an editor's, and a second
 * implementation of that rule is how the two screens start disagreeing about
 * who can open what.
 */
export async function getOrgMemberDetail(
  orgId: string,
  userId: string,
  callerId: string,
): Promise<OrgMemberDetail> {
  const detail = await getOrgAdminDetail(orgId, callerId);
  const member = detail.members.find((m) => m.user_id === userId);
  if (!member) throw new OrgAdminError(404, "not_found", "That person is not in this organization.");

  const owners = detail.members.filter((m) => m.role === "owner").length;

  const [agents, totals] = await Promise.all([
    listMemberAgents(orgId, userId),
    getOrgUsageTotals(orgId),
  ]);
  const meters = memberMeters(totals, userId);

  return {
    user_id: member.user_id,
    email: member.email,
    name: member.name,
    role: member.role,
    joined_at: member.joined_at,
    last_sign_in_at: member.last_sign_in_at,
    confirmed: member.confirmed,
    is_you: member.is_you,
    is_last_owner: member.role === "owner" && owners <= 1,
    workspaces: member.workspaces,
    agents,
    period: totals.period,
    meters,
  };
}

/**
 * The agents this person connected, and where each one reaches inside this
 * organization. Access it holds in somebody else's company is none of this
 * screen's business, so the workspace filter is the organization's own.
 */
async function listMemberAgents(
  orgId: string,
  userId: string,
): Promise<OrgMemberAgent[]> {
  const sb = getSupabaseAdmin();
  const { data: wsRows } = await sb
    .from("workspaces")
    .select("id, slug, name")
    .eq("organization_id", orgId);
  const workspaceById = new Map(
    ((wsRows ?? []) as Array<{ id: string; slug: string; name: string }>).map((w) => [w.id, w]),
  );
  if (workspaceById.size === 0) return [];

  const { data: agentRows } = await sb
    .from("agents")
    .select("id, name, provider, created_at, last_seen_at")
    .eq("owner_user_id", userId)
    .order("created_at", { ascending: false });
  const agents = (agentRows ?? []) as Array<{
    id: string;
    name: string;
    provider: string | null;
    created_at: string;
    last_seen_at: string | null;
  }>;
  if (agents.length === 0) return [];

  const { data: accessRows } = await sb
    .from("agent_workspace_access")
    .select("agent_id, workspace_id, scopes")
    .in("agent_id", agents.map((a) => a.id))
    .in("workspace_id", [...workspaceById.keys()])
    .is("revoked_at", null);
  const access = (accessRows ?? []) as Array<{
    agent_id: string;
    workspace_id: string;
    scopes: string[] | null;
  }>;

  const byAgent = new Map<string, OrgMemberAgent["workspaces"]>();
  for (const row of access) {
    const ws = workspaceById.get(row.workspace_id);
    if (!ws) continue;
    const list = byAgent.get(row.agent_id) ?? [];
    list.push({ id: ws.id, slug: ws.slug, name: ws.name, scopes: row.scopes ?? [] });
    byAgent.set(row.agent_id, list);
  }

  // An agent that reaches nothing in this organization belongs to another one
  // and is not this administrator's to see.
  return agents
    .filter((a) => byAgent.has(a.id))
    .map((a) => ({
      id: a.id,
      name: a.name,
      provider: a.provider,
      created_at: a.created_at,
      last_used_at: a.last_seen_at,
      workspaces: (byAgent.get(a.id) ?? []).sort((x, y) => x.name.localeCompare(y.name)),
    }));
}

/** What this person consumed on every meter, beside the organization's total. */
function memberMeters(totals: OrgUsageTotals, userId: string): OrgMemberMeter[] {
  return USAGE_KINDS.map((kind) => {
    const meter = totals.meters[kind];
    const mine = meter.by_member.find((m) => m.user_id === userId)?.count ?? 0;
    return { kind, used: mine, org_used: meter.total };
  });
}
