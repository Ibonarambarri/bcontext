/**
 * Every non-human thing that can read this organization's context.
 *
 * The list existed already, but only one workspace at a time
 * (`/api/agents/connections?workspace=…`), which is no way to answer the
 * question an administrator actually has: what can read our data, and who is
 * answerable for it. So this is that list transposed — one row per agent, with
 * every workspace it reaches underneath it.
 *
 * Access, as everywhere else, is `agent_workspace_access` with `revoked_at`
 * null. A revoked row is not a dimmed entry here; it is simply gone, because
 * the tab answers a present-tense question.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { joinName } from "@bcontext-dev/contract/me";
import { namesFromUser } from "@/lib/auth/profile";
import type { OrgAgent, OrgAgentList } from "@bcontext-dev/contract/organizations";

interface AccessRow {
  agent_id: string;
  workspace_id: string;
  scopes: string[] | null;
}

interface AgentRow {
  id: string;
  name: string;
  provider: string | null;
  owner_user_id: string;
  created_at: string;
  last_seen_at: string | null;
}

/**
 * Agents connected anywhere in the organization.
 *
 * The caller must already have established that the actor administers the
 * organization; `gateOrgAdmin` does that and this function does not re-check.
 */
export async function listOrgAgents(organizationId: string): Promise<OrgAgentList> {
  const sb = getSupabaseAdmin();

  const { data: wsRows } = await sb
    .from("workspaces")
    .select("id, slug, name")
    .eq("organization_id", organizationId);
  const workspaces = (wsRows ?? []) as Array<{ id: string; slug: string; name: string }>;
  const workspaceById = new Map(workspaces.map((w) => [w.id, w]));
  if (workspaces.length === 0) return { agents: [] };

  const { data: accessRows } = await sb
    .from("agent_workspace_access")
    .select("agent_id, workspace_id, scopes")
    .in("workspace_id", [...workspaceById.keys()])
    .is("revoked_at", null);
  const access = (accessRows ?? []) as AccessRow[];
  const agentIds = [...new Set(access.map((r) => r.agent_id))];
  if (agentIds.length === 0) return { agents: [] };

  const { data: agentRows } = await sb
    .from("agents")
    .select("id, name, provider, owner_user_id, created_at, last_seen_at")
    .in("id", agentIds);
  const agents = (agentRows ?? []) as AgentRow[];

  const [lastUsed, owners] = await Promise.all([
    lastUsedByAgent(agentIds),
    ownersById([...new Set(agents.map((a) => a.owner_user_id))]),
  ]);

  const accessByAgent = new Map<string, AccessRow[]>();
  for (const row of access) {
    const list = accessByAgent.get(row.agent_id) ?? [];
    list.push(row);
    accessByAgent.set(row.agent_id, list);
  }

  const rows: OrgAgent[] = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    provider: agent.provider,
    created_at: agent.created_at,
    last_used_at: newest(agent.last_seen_at, lastUsed.get(agent.id) ?? null),
    // The owner of the agent identity, not whoever approved it in a given
    // workspace: the question is who is answerable for the thing existing, and
    // that person is the same in every workspace it reaches.
    //
    // The id travels with the email because the panel groups agents under the
    // person answerable for them, and an address is a label rather than a key:
    // group on the email and one person becomes two the day they change it,
    // while their agents keep pointing at the same row in `auth.users`.
    connected_by_user_id: agent.owner_user_id,
    connected_by_email: owners.get(agent.owner_user_id)?.email ?? null,
    connected_by_name: owners.get(agent.owner_user_id)?.name ?? null,
    workspaces: (accessByAgent.get(agent.id) ?? [])
      .flatMap((row) => {
        const ws = workspaceById.get(row.workspace_id);
        return ws
          ? [{ id: ws.id, slug: ws.slug, name: ws.name, scopes: row.scopes ?? [] }]
          : [];
      })
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  }));

  // Most recently active first; an agent that has never been used sorts last,
  // which is exactly the one an administrator wants to notice and revoke.
  rows.sort((a, b) => (b.last_used_at ?? "").localeCompare(a.last_used_at ?? ""));
  return { agents: rows };
}

/**
 * "Last used" is not one column. `agents.last_seen_at` is the durable
 * identity's own stamp, but a session is authenticated by a token, and each of
 * the three token tables keeps its own `last_used_at`. An agent that has only
 * ever connected over OAuth has a null `last_seen_at` and a live
 * `oauth_access_tokens.last_used_at`, so reading either one alone reports
 * agents as unused that are not. The newest across all four is the honest
 * answer; null means nothing has recorded a use, which is a real state (a
 * connection approved and never taken up) and not a gap in the data.
 */
export async function lastUsedByAgent(agentIds: string[]): Promise<Map<string, string>> {
  const sb = getSupabaseAdmin();
  const out = new Map<string, string>();
  const tables = ["api_tokens", "oauth_access_tokens", "user_api_tokens"] as const;

  const results = await Promise.all(
    tables.map((table) =>
      sb
        .from(table)
        .select("agent_id, last_used_at")
        .in("agent_id", agentIds)
        .is("revoked_at", null),
    ),
  );

  for (const { data } of results) {
    for (const row of (data ?? []) as Array<{
      agent_id: string | null;
      last_used_at: string | null;
    }>) {
      if (!row.agent_id || !row.last_used_at) continue;
      const best = newest(out.get(row.agent_id) ?? null, row.last_used_at);
      if (best) out.set(row.agent_id, best);
    }
  }
  return out;
}

function newest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** The owner of an agent, as this list needs to name them. */
interface AgentOwner {
  email: string | null;
  /** Both halves of the profile name, joined; null when never given. */
  name: string | null;
}

/**
 * Emails and names live in `auth.users`, which is only reachable through the
 * admin API. Paged the same way `listAdminUsers` pages it, and for the same
 * reason: past a thousand accounts this is not the right tool any more.
 *
 * Both fields come out of the same walk rather than one lookup each, because
 * the walk is the expensive part — the auth server has no "give me these ids"
 * call, so asking twice would page the entire user list twice to answer one
 * screen.
 */
async function ownersById(userIds: string[]): Promise<Map<string, AgentOwner>> {
  const wanted = new Set(userIds);
  const out = new Map<string, AgentOwner>();
  if (wanted.size === 0) return out;
  const sb = getSupabaseAdmin();
  for (let page = 1; page <= 5; page++) {
    const { data } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    const batch = data?.users ?? [];
    for (const user of batch) {
      if (!wanted.has(user.id)) continue;
      out.set(user.id, { email: user.email ?? null, name: joinName(namesFromUser(user)) });
    }
    if (batch.length < 200 || out.size === wanted.size) break;
  }
  return out;
}
