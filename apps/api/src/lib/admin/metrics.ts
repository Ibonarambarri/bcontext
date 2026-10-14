/**
 * The instance admin's usage dashboard: model calls, what they cost, and
 * recorded meeting time, per month, across the whole instance.
 *
 * Called by `GET /api/admin/metrics` (behind `gateAdmin`); service-role
 * client throughout. The AI line is measured from the usage ledger
 * (`ai_usage_events.cost_usd`, summed in Postgres by `admin_ai_spend`), never
 * modelled: a DeepSeek extraction and a Sonnet chat turn are both "one call"
 * and cost orders of magnitude apart. A ledger that cannot be read reports
 * `null`, not an estimate dressed as a measurement.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { sumAiCostUsd } from "@/lib/admin/ai-spend";
import type { DashboardMetrics, PeriodMetrics } from "@bcontext-dev/contract/admin-metrics";

export type { DashboardMetrics, PeriodMetrics } from "@bcontext-dev/contract/admin-metrics";

function periodAtOffset(base: Date, monthsBack: number): string {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - monthsBack, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** [current, prev, prev-1, …] of length n. */
export function recentPeriods(n: number, base: Date = new Date()): string[] {
  return Array.from({ length: n }, (_, i) => periodAtOffset(base, i));
}

/** First instant of a `YYYY-MM` bucket, in UTC — how every counter buckets. */
function periodStartDate(period: string): Date {
  const [year = 1970, month = 1] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

function nextPeriodStart(period: string): Date {
  const [year = 1970, month = 1] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1));
}

export async function computeDashboard(periods: string[]): Promise<DashboardMetrics> {
  const sb = getSupabaseAdmin();
  const out: PeriodMetrics[] = [];
  for (const period of periods) {
    const from = periodStartDate(period);
    const to = nextPeriodStart(period);
    const [{ count: aiEventCount }, aiCostUsd, { data: meetRows }] = await Promise.all([
      sb
        .from("ai_usage_events")
        .select("id", { count: "exact", head: true })
        .gte("created_at", from.toISOString())
        .lt("created_at", to.toISOString()),
      sumAiCostUsd(from, to),
      sb.from("meeting_usage_counters").select("minutes").eq("period", period),
    ]);
    const meetingMinutes = ((meetRows ?? []) as Array<{ minutes: number | null }>).reduce(
      (sum, r) => sum + (r.minutes ?? 0),
      0,
    );
    out.push({
      period,
      aiQueries: aiEventCount ?? 0,
      aiCostUsd: aiCostUsd === null ? null : Math.round(aiCostUsd * 100) / 100,
      meetingMinutes,
      meetingHours: Math.round((meetingMinutes / 60) * 10) / 10,
    });
  }
  return { generatedAt: new Date().toISOString(), periods: out };
}
