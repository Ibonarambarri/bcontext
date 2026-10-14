/**
 * May this Nexo spend money right now?
 *
 * The Nexo's own `monthly_budget_credits` (USD), set by whoever configures
 * it, is checked before every headless run and every specialist chat turn
 * against what its calls cost this calendar month (UTC). It is the guard
 * against an autonomous agent running up a provider bill. The month is read
 * from `ai_usage_events` by `metadata.nexo_id` (indexed in 0096); a call on
 * the organization's own key (BYOK) is recorded at cost 0 so the instance's
 * spend figures stay the instance's, with its real price in
 * `metadata.byok_cost_usd`, and both count here — a budget caps the Nexo
 * whoever pays.
 *
 * Callers: `./runner`, `@/lib/nexo/assistant/turn`, and the triggers (which
 * may skip enqueueing an over-budget Nexo). Must not break: fails OPEN like
 * every other meter — an unreadable ledger never stops a Nexo — and the
 * "presupuesto agotado" escalation is filed once per Nexo per month, not once
 * per heartbeat.
 */
import { log } from "@bcontext-dev/contract/log";
import type { Nexo, NexoInboxItem } from "@bcontext-dev/contract/nexos";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { estimateCostUsd, recordAiUsageEvent, tokensFromUsage } from "@/lib/telemetry/ai-usage";
import { createInboxItem, listInbox } from "@/lib/nexos/store";
import type { NexoTarget } from "@/lib/nexos/types";

export type NexoBudgetVerdict =
  | { ok: true; spentUsd: number }
  | { ok: false; reason: "nexo_budget"; message: string; spentUsd: number; limitUsd: number | null };

/** `YYYY-MM` in UTC: the budget period and the escalation's dedupe key. */
export function budgetMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * The demo backend has no usage ledger; it keeps a tally per Nexo and month
 * so the in-memory path (and tests) can exercise the ceiling.
 */
const demoSpend = new Map<string, number>();

export function noteDemoNexoSpend(nexoId: string, usd: number, now: Date = new Date()): void {
  const key = `${nexoId}:${budgetMonth(now)}`;
  demoSpend.set(key, (demoSpend.get(key) ?? 0) + usd);
}

export function resetNexoBudgetForTests(): void {
  demoSpend.clear();
}

/** What the Nexo's calls have cost this month, in USD (ours + BYOK). */
export async function nexoMonthSpendUsd(t: NexoTarget, nexoId: string, now: Date = new Date()): Promise<number> {
  if (t.backend !== "supabase") return demoSpend.get(`${nexoId}:${budgetMonth(now)}`) ?? 0;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("ai_usage_events")
      .select("cost_usd,metadata")
      .eq("workspace_id", t.workspaceId)
      .eq("metadata->>nexo_id", nexoId)
      .gte("created_at", monthStart(now))
      .limit(20_000);
    if (error) throw new Error(error.message);
    let total = 0;
    for (const row of (data ?? []) as Array<{ cost_usd: unknown; metadata: Record<string, unknown> | null }>) {
      total += Number(row.cost_usd) || 0;
      total += Number(row.metadata?.byok_cost_usd) || 0;
    }
    return total;
  } catch (err) {
    log.warn("nexos.budget.read_failed", { nexo_id: nexoId, error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

export async function checkNexoBudget(args: {
  target: NexoTarget;
  nexo: Pick<Nexo, "id" | "monthly_budget_credits">;
  now?: Date;
}): Promise<NexoBudgetVerdict> {
  const now = args.now ?? new Date();
  const limit = args.nexo.monthly_budget_credits;
  if (limit == null) return { ok: true, spentUsd: 0 };
  const spent = await nexoMonthSpendUsd(args.target, args.nexo.id, now);
  if (spent >= limit) {
    return {
      ok: false,
      reason: "nexo_budget",
      message: `Este Nexo ha gastado ${spent.toFixed(2)} de ${limit} créditos este mes.`,
      spentUsd: spent,
      limitUsd: limit,
    };
  }
  return { ok: true, spentUsd: spent };
}

/**
 * File the "presupuesto agotado" escalation unless this month's already
 * exists. Returns the item when one was created (the caller notifies),
 * null otherwise. Best-effort: never throws.
 */
export async function escalateBudgetOnce(args: {
  target: NexoTarget;
  nexo: Pick<Nexo, "id" | "name">;
  verdict: Extract<NexoBudgetVerdict, { ok: false }>;
  runId?: string | null;
  now?: Date;
}): Promise<NexoInboxItem | null> {
  const month = budgetMonth(args.now);
  try {
    const existing = await listInbox(args.target, { nexoId: args.nexo.id, limit: 200 });
    const already = existing.some(
      (i) => i.kind === "escalation" && i.payload.reason === "budget" && i.payload.month === month,
    );
    if (already) return null;
    return await createInboxItem(args.target, {
      nexoId: args.nexo.id,
      runId: args.runId ?? null,
      kind: "escalation",
      title: `${args.nexo.name}: presupuesto agotado`,
      body_md: `${args.verdict.message}\n\nNo trabajará hasta el mes que viene salvo que subas su presupuesto en Ajustes.`,
      payload: { reason: "budget", month, scope: args.verdict.reason, spent_usd: args.verdict.spentUsd, limit_usd: args.verdict.limitUsd },
    });
  } catch (err) {
    log.warn("nexos.budget.escalate_failed", { nexo_id: args.nexo.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Record one Nexo call in the usage ledger under `metadata.nexo_id`, so the
 * budget above sees it. A BYOK call is written at cost 0 (the organization's
 * provider bills it, not the instance's) with its market price kept in
 * `byok_cost_usd`. On the demo backend the estimate goes to the in-memory
 * tally instead. Never throws; returns the estimated cost.
 */
export async function recordNexoUsage(args: {
  target: NexoTarget;
  nexoId: string;
  subjectUserId?: string | null;
  modelId: string;
  byok: string | null;
  usage: Parameters<typeof tokensFromUsage>[0];
  providerMetadata?: Record<string, Record<string, unknown>>;
  metadata?: Record<string, string | number | boolean | null>;
}): Promise<number> {
  const tokens = tokensFromUsage(args.usage);
  const estimate = estimateCostUsd(args.modelId, tokens, args.providerMetadata);
  if (args.target.backend !== "supabase") {
    noteDemoNexoSpend(args.nexoId, estimate);
    return estimate;
  }
  await recordAiUsageEvent({
    workspaceId: args.target.workspaceId,
    subjectUserId: args.subjectUserId ?? null,
    surface: "nexo",
    model: args.modelId,
    tokens,
    ...(args.byok ? { providerCostUsd: 0 } : { providerMetadata: args.providerMetadata }),
    metadata: {
      ...(args.metadata ?? {}),
      nexo_id: args.nexoId,
      ...(args.byok ? { byok: args.byok, byok_cost_usd: estimate } : {}),
    },
  });
  return estimate;
}
