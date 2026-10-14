/**
 * What an organization is consuming, for the usage tab of the org modal.
 *
 * Everything here is MEASURED: a row the database already counts, read back
 * unchanged. Nothing is estimated, extrapolated or priced, so every figure
 * can be traced to rows someone can be shown.
 *
 * The sources, and what each one is honestly able to say:
 *
 *   nodes                  how much context exists, per workspace
 *   activity               one row per WRITE, with the verb and `actor_kind` —
 *                          the only place that knows whether a person or an
 *                          agent made the change
 *   mcp_usage_counters     tool calls per workspace/month/tool (0069) — the
 *                          only measure of READS; `activity` has none
 *   org_usage_counters     what the organization consumed, per person and
 *                          month (0070)
 *   meeting_usage_counters recorded meeting minutes, per workspace and month
 *
 * The period is the current UTC month as `YYYY-MM`, the convention every one
 * of those counters already uses (`currentPeriod` in `./meters`).
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { currentPeriod } from "./meters";
import type {
  OrgMcpUsage,
  OrgUsage,
  OrgUsageWorkspace,
} from "@bcontext-dev/contract/organizations";

/* -------------------------------------------------------------------------- */
/*  Activity aggregation (pure)                                               */
/* -------------------------------------------------------------------------- */

/**
 * A write, as `activity` records it. `deleted` is a write like any other — it
 * is work the organization did — but it is neither a creation nor an edit, so
 * it lands in the actor split and nowhere else.
 */
export interface ActivityRow {
  workspace_id: string;
  verb: string;
  actor_kind: string;
}

const CREATE_VERBS = new Set(["created"]);
/** Renaming and moving change the graph; from the tab's angle they are edits. */
const EDIT_VERBS = new Set(["updated", "renamed", "moved"]);
export const WRITE_VERBS = new Set([...CREATE_VERBS, ...EDIT_VERBS, "deleted"]);

export interface ActivityTotals {
  nodes_created: number;
  nodes_edited: number;
  writes_by_people: number;
  writes_by_agents: number;
  by_workspace: Map<string, { created: number; edited: number }>;
}

/**
 * Fold raw activity rows into the counts the tab shows.
 *
 * The actor split is the point of this function and the most interesting
 * number on the screen: it is the only way to answer "how much of our context
 * did our agents write". `actor_kind` has a third value, `system` — migrations
 * and backfills — and it is deliberately in NEITHER side. Folding it into
 * `writes_by_people` would credit humans with work no human did, and folding
 * it into agents would inflate the number the tab exists to make honest. It
 * still counts toward created/edited, because those nodes are really there.
 *
 * So `writes_by_people + writes_by_agents <= nodes_created + nodes_edited +
 * deletions`, and that gap is real rather than a rounding error.
 */
export function aggregateActivity(rows: ActivityRow[]): ActivityTotals {
  const totals: ActivityTotals = {
    nodes_created: 0,
    nodes_edited: 0,
    writes_by_people: 0,
    writes_by_agents: 0,
    by_workspace: new Map(),
  };

  for (const row of rows) {
    if (!WRITE_VERBS.has(row.verb)) continue;

    const bucket = totals.by_workspace.get(row.workspace_id) ?? {
      created: 0,
      edited: 0,
    };
    if (CREATE_VERBS.has(row.verb)) {
      totals.nodes_created += 1;
      bucket.created += 1;
    } else if (EDIT_VERBS.has(row.verb)) {
      totals.nodes_edited += 1;
      bucket.edited += 1;
    }
    totals.by_workspace.set(row.workspace_id, bucket);

    if (row.actor_kind === "human") totals.writes_by_people += 1;
    else if (row.actor_kind === "agent") totals.writes_by_agents += 1;
  }

  return totals;
}

/* -------------------------------------------------------------------------- */
/*  MCP aggregation (pure)                                                    */
/* -------------------------------------------------------------------------- */

export interface McpCounterRow {
  workspace_id: string;
  tool: string;
  calls: number;
}

export function aggregateMcpCalls(rows: McpCounterRow[]): {
  usage: OrgMcpUsage;
  by_workspace: Map<string, number>;
} {
  const byTool = new Map<string, number>();
  const byWorkspace = new Map<string, number>();
  let total = 0;

  for (const row of rows) {
    const calls = Number(row.calls) || 0;
    total += calls;
    byTool.set(row.tool, (byTool.get(row.tool) ?? 0) + calls);
    byWorkspace.set(
      row.workspace_id,
      (byWorkspace.get(row.workspace_id) ?? 0) + calls,
    );
  }

  const by_tool = [...byTool.entries()]
    .map(([tool, calls]) => ({ tool, calls }))
    // Busiest first: the tab is read top-down and the long tail is noise.
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));

  return { usage: { total, by_tool }, by_workspace: byWorkspace };
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `activity` is read as rows rather than as counts because the split the tab
 * needs — per workspace AND per actor kind — is a group-by PostgREST cannot
 * express, and asking for it as N separate `count` queries would be one
 * round-trip per workspace per bucket. Rows are three small columns, and the
 * page is bounded: past this many writes in a month an organization has
 * outgrown row-level aggregation and needs a rollup table, which is a
 * different piece of work than a usage tab.
 */
const ACTIVITY_PAGE = 1000;
const ACTIVITY_MAX_PAGES = 200;

async function fetchActivity(
  workspaceIds: string[],
  since: string,
): Promise<ActivityRow[]> {
  if (workspaceIds.length === 0) return [];
  const sb = getSupabaseAdmin();
  const rows: ActivityRow[] = [];
  for (let page = 0; page < ACTIVITY_MAX_PAGES; page++) {
    const from = page * ACTIVITY_PAGE;
    const { data, error } = await sb
      .from("activity")
      .select("workspace_id, verb, actor_kind")
      .in("workspace_id", workspaceIds)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, from + ACTIVITY_PAGE - 1);
    if (error) break; // Partial counts beat a broken tab; nothing here is billed.
    const batch = (data ?? []) as ActivityRow[];
    rows.push(...batch);
    if (batch.length < ACTIVITY_PAGE) break;
  }
  return rows;
}

/** First instant of the `YYYY-MM` bucket, as the counters define it: UTC. */
export function periodStart(period: string): string {
  const [year = 1970, month = 1] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toISOString();
}

/**
 * Everything the usage tab shows for one organization.
 *
 * Caller must already have established that the actor administers the
 * organization — `gateOrgAdmin` does that, and this function does not
 * re-check.
 */
export async function getOrgUsage(
  organizationId: string,
  now: Date = new Date(),
): Promise<OrgUsage> {
  const sb = getSupabaseAdmin();
  const period = currentPeriod(now);
  const since = periodStart(period);

  const { data: wsRows } = await sb
    .from("workspaces")
    .select("id, slug, name")
    .eq("organization_id", organizationId)
    .order("slug", { ascending: true });
  const workspaces = (wsRows ?? []) as Array<{ id: string; slug: string; name: string }>;
  const workspaceIds = workspaces.map((w) => w.id);

  const { data: memberRows } = await sb
    .from("organization_memberships")
    .select("user_id")
    .eq("organization_id", organizationId);
  const memberIds = ((memberRows ?? []) as Array<{ user_id: string }>).map(
    (m) => m.user_id,
  );

  const [activity, mcpRows, nodeCounts, meetingRows, ai] = await Promise.all([
    fetchActivity(workspaceIds, since),
    fetchMcpCounters(workspaceIds, period),
    countNodes(workspaceIds),
    fetchMeetingMinutes(workspaceIds, period),
    fetchAiQueries(organizationId, period),
  ]);

  const activityTotals = aggregateActivity(activity);
  const mcp = aggregateMcpCalls(mcpRows);

  const perWorkspace: OrgUsageWorkspace[] = workspaces.map((w) => {
    const writes = activityTotals.by_workspace.get(w.id);
    return {
      id: w.id,
      slug: w.slug,
      name: w.name,
      node_count: nodeCounts.get(w.id) ?? 0,
      nodes_created: writes?.created ?? 0,
      nodes_edited: writes?.edited ?? 0,
      meeting_minutes: meetingRows.get(w.id) ?? 0,
      mcp_calls: mcp.by_workspace.get(w.id) ?? 0,
    };
  });

  return {
    period,
    nodes_total: perWorkspace.reduce((sum, w) => sum + w.node_count, 0),
    nodes_created: activityTotals.nodes_created,
    nodes_edited: activityTotals.nodes_edited,
    writes_by_people: activityTotals.writes_by_people,
    writes_by_agents: activityTotals.writes_by_agents,
    ai_queries: ai,
    meeting_minutes: perWorkspace.reduce((sum, w) => sum + w.meeting_minutes, 0),
    member_count: memberIds.length,
    agent_count: await countAgents(workspaceIds),
    mcp_calls: mcp.usage,
    workspaces: perWorkspace,
  };
}

async function fetchMcpCounters(
  workspaceIds: string[],
  period: string,
): Promise<McpCounterRow[]> {
  if (workspaceIds.length === 0) return [];
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("mcp_usage_counters")
    .select("workspace_id, tool, calls")
    .in("workspace_id", workspaceIds)
    .eq("period", period);
  // The table arrives with migration 0069; on a database that has not applied
  // it yet the tab shows zero reads rather than a 500.
  if (error) return [];
  return (data ?? []) as McpCounterRow[];
}

export async function countNodes(workspaceIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workspaceIds.length === 0) return out;
  const sb = getSupabaseAdmin();
  // One exact count per workspace, in parallel: `head: true` transfers no
  // rows, which matters because a workspace can hold tens of thousands.
  await Promise.all(
    workspaceIds.map(async (id) => {
      const { count } = await sb
        .from("nodes")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", id);
      out.set(id, count ?? 0);
    }),
  );
  return out;
}

async function fetchMeetingMinutes(
  workspaceIds: string[],
  period: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workspaceIds.length === 0) return out;
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("meeting_usage_counters")
    .select("workspace_id, minutes")
    .in("workspace_id", workspaceIds)
    .eq("period", period);
  for (const row of (data ?? []) as Array<{
    workspace_id: string;
    minutes: number | null;
  }>) {
    out.set(row.workspace_id, (out.get(row.workspace_id) ?? 0) + (row.minutes ?? 0));
  }
  return out;
}

async function countAgents(workspaceIds: string[]): Promise<number> {
  if (workspaceIds.length === 0) return 0;
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("agent_workspace_access")
    .select("agent_id")
    .in("workspace_id", workspaceIds)
    .is("revoked_at", null);
  // Distinct: one agent reaching four workspaces is one thing that can read
  // the company's context, not four.
  const ids = new Set(
    ((data ?? []) as Array<{ agent_id: string }>).map((r) => r.agent_id),
  );
  return ids.size;
}

/** Model calls the organization's people and agents made this month. */
async function fetchAiQueries(organizationId: string, period: string): Promise<number> {
  const { data } = await getSupabaseAdmin()
    .from("org_usage_counters")
    .select("count")
    .eq("organization_id", organizationId)
    .eq("period", period)
    .eq("kind", "ai_queries");
  return ((data ?? []) as Array<{ count: number | null }>).reduce(
    (sum, row) => sum + (row.count ?? 0),
    0,
  );
}
