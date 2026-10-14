/**
 * The instance admin's usage dashboard, as the API computes it and the web
 * renders it: what the whole instance consumed per month. Measured, not
 * modelled — there is no revenue side on a self-hosted instance, only what
 * the operator's AI provider and meeting bot will bill them.
 */

export interface PeriodMetrics {
  /** `YYYY-MM`, UTC. */
  period: string;
  /** Model calls recorded in the period, counted from `ai_usage_events`. */
  aiQueries: number;
  /**
   * What those calls cost in USD: the sum of `ai_usage_events.cost_usd` (the
   * gateway's reported cost, or the per-model price table when it reports
   * none). `null` when the ledger could not be read.
   */
  aiCostUsd: number | null;
  meetingMinutes: number;
  meetingHours: number;
}

export interface DashboardMetrics {
  generatedAt: string;
  /** Most recent month first. */
  periods: PeriodMetrics[];
}
