/**
 * What each organization's AI calls cost, read from the usage ledger.
 *
 * Called by the admin organizations list and detail (`src/lib/admin/orgs.ts`)
 * and by the usage dashboard (`src/lib/admin/metrics.ts`). Everything runs on
 * the service-role client, so every caller must have gone through
 * `gateAdmin` first.
 *
 * The source is `ai_usage_events.cost_usd`, one row per model call, summed
 * in Postgres by `admin_ai_spend` (migration 0093): the events grow by
 * thousands a month, and paging them into TypeScript to add them up is the
 * query that gets worse with every organization.
 *
 * Do not break: a failed read degrades to `null`/zero with a warning, never
 * to a 500 — the customer list and the dashboard are still worth drawing
 * without this column.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@bcontext-dev/contract/log";

/**
 * The spend figures that ride on an organization row in the admin panel.
 * Amounts are USD, rounded to the ledger's own precision (six decimals), so
 * a cheap month of embeddings does not vanish to $0.00 before the panel
 * decides how to print it.
 */
export interface AdminOrgAiSpend {
  /** Every AI call this organization's workspaces ever made. */
  total_usd: number;
  total_events: number;
  /** The rolling window the operator actually compares customers on. */
  last_30d_usd: number;
  last_30d_events: number;
  /**
   * Calls priced by the code's fallback table that consumed tokens and came
   * out at $0 — which can only mean a model missing from that table. Zero
   * is the healthy value; anything else is a hole in the accounting.
   */
  unpriced_events: number;
}

const DAY_MS = 86_400_000;

interface SpendRow {
  organization_id: string;
  events: number | string | null;
  cost_usd: number | string | null;
  unpriced_events: number | string | null;
}

/** PostgREST hands `numeric` and `bigint` back as strings; the panel wants numbers. */
function num(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** The ledger stores six decimals; summing them in JS must not invent a seventh. */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * One call of the aggregate. `null` when the function is not there yet or
 * the read failed, so the caller can tell "no spend" from "no answer".
 */
async function readSpend(args: {
  since?: Date | null;
  until?: Date | null;
  organizationIds?: string[] | null;
}): Promise<SpendRow[] | null> {
  const { data, error } = await getSupabaseAdmin().rpc("admin_ai_spend", {
    p_since: args.since?.toISOString() ?? null,
    p_until: args.until?.toISOString() ?? null,
    p_organization_ids: args.organizationIds ?? null,
  });
  if (error) {
    log.warn("admin.ai_spend.read_failed", { error: { message: error.message } });
    return null;
  }
  return (data ?? []) as SpendRow[];
}

/**
 * Spend per organization, total and over the last 30 days, for the
 * organizations on the page — two reads whatever the page size.
 *
 * Organizations with no events are simply absent from the map; the caller
 * prints zero for them. When the ledger cannot be read the map is empty and
 * `available` is false, so the panel can say "unavailable" rather than "$0".
 */
export async function fetchOrgAiSpend(
  organizationIds: string[],
  now: Date = new Date(),
): Promise<{ available: boolean; byOrg: Map<string, AdminOrgAiSpend> }> {
  const byOrg = new Map<string, AdminOrgAiSpend>();
  if (organizationIds.length === 0) return { available: true, byOrg };

  const since = new Date(now.getTime() - 30 * DAY_MS);
  const [total, recent] = await Promise.all([
    readSpend({ organizationIds }),
    readSpend({ since, organizationIds }),
  ]);
  if (total === null || recent === null) return { available: false, byOrg };

  for (const row of total) {
    byOrg.set(row.organization_id, {
      total_usd: round6(num(row.cost_usd)),
      total_events: num(row.events),
      last_30d_usd: 0,
      last_30d_events: 0,
      unpriced_events: num(row.unpriced_events),
    });
  }
  for (const row of recent) {
    const entry = byOrg.get(row.organization_id);
    // A row in the window without one in the total cannot happen — the
    // window is a subset — but a missing entry is safer printed as zero
    // than as a crash.
    if (!entry) continue;
    entry.last_30d_usd = round6(num(row.cost_usd));
    entry.last_30d_events = num(row.events);
  }
  return { available: true, byOrg };
}

/** The row printed for an organization that never made a call. */
export const NO_AI_SPEND: AdminOrgAiSpend = {
  total_usd: 0,
  total_events: 0,
  last_30d_usd: 0,
  last_30d_events: 0,
  unpriced_events: 0,
};

/**
 * What every AI call between two instants cost, platform-wide. `null` when
 * the ledger could not be read, so the dashboard can say so instead of
 * printing a confident zero.
 */
export async function sumAiCostUsd(since: Date, until: Date): Promise<number | null> {
  const rows = await readSpend({ since, until });
  if (rows === null) return null;
  return round6(rows.reduce((sum, row) => sum + num(row.cost_usd), 0));
}
