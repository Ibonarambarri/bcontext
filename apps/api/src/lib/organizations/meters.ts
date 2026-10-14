/**
 * What an organization consumes, per person and per month — counted for the
 * people who run it, never enforced.
 *
 * Called by the MCP server (`ask_rag`, `ask_nexo`), the Nexo chat, autofix,
 * the meeting-bot webhook and the MCP usage flush (`recordUsage`), and by the
 * organization's member screen (`getOrgUsageTotals`). A self-hosted instance
 * has no ceilings: these numbers answer "who and what is using the model,
 * the meeting bot and the context", which an administrator still needs.
 *
 * Three of the four meters are FLOWS and live in `org_usage_counters`
 * (migration 0070). `nodes` is a STOCK — how much context the organization
 * holds right now — and is counted from the `nodes` table, which is the only
 * thing that still tells the truth after a deletion.
 *
 * Must not break: recording never throws and never blocks the call it
 * describes; the counter may undercount, the product may not fail.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@bcontext-dev/contract/log";
import type { UsageKind } from "@bcontext-dev/contract/organizations";

/** YYYY-MM bucket in UTC. Stable across the entire calendar month. */
export function currentPeriod(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** The meters `org_usage_counters` accepts. `nodes` is a stock, not a flow. */
export type FlowUsageKind = Exclude<UsageKind, "nodes">;

const FLOW_KINDS: readonly FlowUsageKind[] = [
  "ai_queries",
  "mcp_calls",
  "meeting_minutes",
];

export function isFlowUsageKind(kind: UsageKind): kind is FlowUsageKind {
  return (FLOW_KINDS as readonly string[]).includes(kind);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/* -------------------------------------------------------------------------- */
/*  Recording                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Note `n` units of consumption against the organization and the person who
 * caused it. The returned promise never rejects, so hot paths drop it with
 * `void`.
 *
 * `mcp_calls` does not come through here one call at a time: it is batched in
 * `src/lib/mcp/usage.ts` and arrives once per flush with the whole count.
 */
export async function recordUsage(
  organizationId: string,
  userId: string | null,
  kind: FlowUsageKind,
  n = 1,
  now: Date = new Date(),
): Promise<void> {
  // A demo organization has no row to reference, and an unattributed agent
  // token has nobody to attribute to: counting either would only produce
  // foreign-key failures.
  if (!isUuid(organizationId) || !isUuid(userId) || n <= 0) return;
  try {
    const { error } = await getSupabaseAdmin().rpc("increment_org_usage", {
      p_organization_id: organizationId,
      p_user_id: userId,
      p_period: currentPeriod(now),
      p_kind: kind,
      p_count: n,
    });
    if (error) {
      log.warn("org.usage.record_failed", {
        organization_id: organizationId,
        kind,
        count: n,
        error: { message: error.message },
      });
    }
  } catch (err: unknown) {
    // A throw here would surface as an unhandled rejection from a call site
    // that deliberately did not await.
    log.warn("org.usage.record_error", {
      organization_id: organizationId,
      kind,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Add recorded meeting minutes to the workspace's monthly counter
 * (`meeting_usage_counters`), which the organization's usage tab and the
 * admin dashboard read.
 */
export async function addMeetingMinutes(
  workspaceId: string,
  minutes: number,
  now: Date = new Date(),
): Promise<void> {
  if (minutes <= 0) return;
  const sb = getSupabaseAdmin();
  const period = currentPeriod(now);
  const existing = await sb
    .from("meeting_usage_counters")
    .select("minutes")
    .eq("workspace_id", workspaceId)
    .eq("period", period)
    .maybeSingle();

  if (!existing.data) {
    await sb.from("meeting_usage_counters").insert({
      workspace_id: workspaceId,
      period,
      minutes,
    });
    return;
  }
  const next = ((existing.data.minutes as number) ?? 0) + minutes;
  await sb
    .from("meeting_usage_counters")
    .update({ minutes: next, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("period", period);
}

/* -------------------------------------------------------------------------- */
/*  Aggregation (pure)                                                        */
/* -------------------------------------------------------------------------- */

/** One row of `org_usage_counters`, as the database stores it. */
export interface OrgCounterRow {
  user_id: string;
  kind: string;
  count: number | null;
}

export interface MeterBreakdown {
  total: number;
  by_member: Map<string, number>;
}

/**
 * Fold counter rows into "what the organization consumed, and who consumed
 * it". Every flow meter is present even with no rows, so a screen does not
 * change shape from one month to the next; unknown kinds are dropped.
 */
export function aggregateOrgCounters(
  rows: readonly OrgCounterRow[],
): Map<FlowUsageKind, MeterBreakdown> {
  const out = new Map<FlowUsageKind, MeterBreakdown>();
  for (const kind of FLOW_KINDS) {
    out.set(kind, { total: 0, by_member: new Map() });
  }
  for (const row of rows) {
    const bucket = out.get(row.kind as FlowUsageKind);
    if (!bucket) continue;
    const count = row.count ?? 0;
    bucket.total += count;
    bucket.by_member.set(
      row.user_id,
      (bucket.by_member.get(row.user_id) ?? 0) + count,
    );
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                   */
/* -------------------------------------------------------------------------- */

export interface OrgMeterUsage {
  kind: UsageKind;
  total: number;
  /** Per person, highest first. Only members who consumed something appear. */
  by_member: { user_id: string; count: number }[];
}

export interface OrgUsageTotals {
  organization_id: string;
  period: string;
  meters: Record<UsageKind, OrgMeterUsage>;
}

async function orgWorkspaceIds(organizationId: string): Promise<string[]> {
  const { data } = await getSupabaseAdmin()
    .from("workspaces")
    .select("id")
    .eq("organization_id", organizationId);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/** The node stock across the organization's workspaces. Counted, never accumulated. */
async function countOrgNodes(workspaceIds: string[]): Promise<number> {
  if (workspaceIds.length === 0) return 0;
  const { count, error } = await getSupabaseAdmin()
    .from("nodes")
    .select("id", { count: "exact", head: true })
    .in("workspace_id", workspaceIds);
  if (error) return 0;
  return count ?? 0;
}

/** Per-member node stock, for the member screen. */
async function nodesByMember(
  workspaceIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workspaceIds.length === 0) return out;
  const { data } = await getSupabaseAdmin()
    .from("nodes")
    .select("created_by")
    .in("workspace_id", workspaceIds);
  for (const row of (data ?? []) as Array<{ created_by: string | null }>) {
    // Nodes created by a migration, an import or a since-deleted account have
    // no author. They still count toward the stock; they just belong to nobody.
    if (!row.created_by) continue;
    out.set(row.created_by, (out.get(row.created_by) ?? 0) + 1);
  }
  return out;
}

function meterFrom(
  kind: UsageKind,
  total: number,
  byMember: Map<string, number>,
): OrgMeterUsage {
  return {
    kind,
    total,
    by_member: [...byMember.entries()]
      .map(([user_id, count]) => ({ user_id, count }))
      .sort((a, b) => b.count - a.count || a.user_id.localeCompare(b.user_id)),
  };
}

/** Everything the organization consumed in `period`, per meter and per person. */
export async function getOrgUsageTotals(
  organizationId: string,
  period: string = currentPeriod(),
): Promise<OrgUsageTotals> {
  const [workspaceIds, { data: rows }] = await Promise.all([
    orgWorkspaceIds(organizationId),
    getSupabaseAdmin()
      .from("org_usage_counters")
      .select("user_id, kind, count")
      .eq("organization_id", organizationId)
      .eq("period", period),
  ]);

  const flows = aggregateOrgCounters((rows ?? []) as OrgCounterRow[]);
  const [nodeStock, nodeAuthors] = await Promise.all([
    countOrgNodes(workspaceIds),
    nodesByMember(workspaceIds),
  ]);

  const empty: MeterBreakdown = { total: 0, by_member: new Map() };
  const flow = (kind: FlowUsageKind) => flows.get(kind) ?? empty;

  return {
    organization_id: organizationId,
    period,
    meters: {
      ai_queries: meterFrom("ai_queries", flow("ai_queries").total, flow("ai_queries").by_member),
      mcp_calls: meterFrom("mcp_calls", flow("mcp_calls").total, flow("mcp_calls").by_member),
      meeting_minutes: meterFrom(
        "meeting_minutes",
        flow("meeting_minutes").total,
        flow("meeting_minutes").by_member,
      ),
      nodes: meterFrom("nodes", nodeStock, nodeAuthors),
    },
  };
}
