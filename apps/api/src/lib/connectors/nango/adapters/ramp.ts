/**
 * Ramp — `ramp` → Nango `ramp` (OAuth2; proxy https://api.ramp.com).
 *
 * Spend, not people: card transactions since the cursor are aggregated per
 * department (totals per merchant, counts), plus reimbursements per
 * department, and the handful of large transactions carry their memo so
 * NEXO can see *why* money moved. No card numbers, no card-holder emails,
 * amounts rounded to whole units.
 *
 * Endpoints (docs): `GET /developer/v1/transactions?from_date&page_size`
 * paged through `page.next` (a URL carrying `start=`), and
 * `GET /developer/v1/reimbursements?from_date`. Both return `{ data, page }`.
 * `config.large_threshold` (default 1000) decides which transactions get
 * their own signal; `config.departments` is an allow-list.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, str, type NangoAdapter } from "./shared";

interface RampTransaction {
  id: string;
  amount?: number;
  currency_code?: string;
  merchant_name?: string;
  merchant_category_code_description?: string;
  memo?: string | null;
  state?: string;
  user_transaction_time?: string;
  settlement_date?: string;
  card_holder?: { department_name?: string; location_name?: string };
  receipts?: unknown[];
  line_items?: Array<{ accounting_field_selections?: Array<{ name?: string }> }>;
  policy_violations?: unknown[];
}

interface RampReimbursement {
  id: string;
  amount?: number;
  currency?: string;
  merchant?: string;
  memo?: string | null;
  state?: string;
  created_at?: string;
  transaction_date?: string;
  user_id?: string;
  department_id?: string | null;
}

interface RampPage<T> {
  data?: T[];
  page?: { next?: string | null };
}

const MAX_PAGES = 5;

function startOf(next: string | null | undefined): string | undefined {
  if (!next) return undefined;
  try {
    return new URL(next, "https://api.ramp.com").searchParams.get("start") ?? undefined;
  } catch {
    return undefined;
  }
}

function fmt(n: number, currency = "USD"): string {
  return `${Math.round(n).toLocaleString("en-US")} ${currency}`;
}

export const rampAdapter: NangoAdapter = {
  id: "ramp",
  provider: "ramp",
  sourceHint: "ramp:spend",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const departmentsAllow = allowList(config, "departments");
    const rawThreshold = config.large_threshold;
    const threshold = typeof rawThreshold === "number" && rawThreshold > 0 ? rawThreshold : 1000;
    const stats: Record<string, number> = { transactions: 0, reimbursements: 0 };
    const signals: IngestSignal[] = [];

    const transactions: RampTransaction[] = [];
    let start: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.proxy<RampPage<RampTransaction>>({
        method: "GET",
        providerConfigKey: "ramp",
        connectionId,
        path: "/developer/v1/transactions",
        query: { from_date: since.toISOString(), page_size: 100, ...(start ? { start } : {}) },
      });
      if (!res.ok) throw new Error(`ramp transactions failed (${res.status})`);
      transactions.push(...(res.data?.data ?? []));
      start = startOf(res.data?.page?.next);
      if (!start) break;
    }

    interface Bucket {
      total: number;
      count: number;
      currency: string;
      merchants: Map<string, number>;
      latest: string;
      violations: number;
      missingReceipts: number;
    }
    const byDept = new Map<string, Bucket>();
    const large: RampTransaction[] = [];
    for (const t of transactions) {
      const dept = str(t.card_holder?.department_name) || "no department";
      if (departmentsAllow && !departmentsAllow.includes(dept)) continue;
      stats.transactions = (stats.transactions ?? 0) + 1;
      const amount = typeof t.amount === "number" ? t.amount : 0;
      const when = t.user_transaction_time ?? t.settlement_date ?? since.toISOString();
      const b = byDept.get(dept) ?? { total: 0, count: 0, currency: t.currency_code ?? "USD", merchants: new Map(), latest: when, violations: 0, missingReceipts: 0 };
      b.total += amount;
      b.count++;
      const merchant = str(t.merchant_name) || "unknown merchant";
      b.merchants.set(merchant, (b.merchants.get(merchant) ?? 0) + amount);
      if (when > b.latest) b.latest = when;
      if (t.policy_violations?.length) b.violations++;
      if (!t.receipts?.length) b.missingReceipts++;
      byDept.set(dept, b);
      if (amount >= threshold) large.push(t);
    }

    // Reimbursements per department (department ids only — resolve to a name when given).
    const reimb = await client.proxy<RampPage<RampReimbursement>>({
      method: "GET",
      providerConfigKey: "ramp",
      connectionId,
      path: "/developer/v1/reimbursements",
      query: { from_date: since.toISOString(), page_size: 100 },
    });
    const reimbByDept = new Map<string, { total: number; count: number }>();
    if (reimb.ok) {
      for (const r of reimb.data?.data ?? []) {
        const created = r.created_at ?? r.transaction_date;
        if (created && new Date(created) <= since) continue;
        stats.reimbursements = (stats.reimbursements ?? 0) + 1;
        const dept = str(r.department_id) || "no department";
        const b = reimbByDept.get(dept) ?? { total: 0, count: 0 };
        b.total += typeof r.amount === "number" ? r.amount : 0;
        b.count++;
        reimbByDept.set(dept, b);
      }
    } else {
      stats.reimbursements_unavailable = 1;
    }

    for (const [dept, b] of byDept) {
      if (signals.length >= limit) break;
      const top = [...b.merchants.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 10)
        .map(([m, v]) => `${m}: ${fmt(v, b.currency)}`)
        .join(", ");
      signals.push({
        external_id: `spend:${dept}:${since.toISOString().slice(0, 10)}`,
        title: `Spend · ${dept} · ${fmt(b.total, b.currency)} across ${b.count} transactions`,
        text: [
          `Period: since ${since.toISOString().slice(0, 10)} · Transactions: ${b.count} · Total: ${fmt(b.total, b.currency)}`,
          top ? `Top merchants: ${top}` : null,
          b.violations ? `Policy violations: ${b.violations}` : null,
          b.missingReceipts ? `Missing receipts: ${b.missingReceipts}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        url: "https://app.ramp.com/transactions",
        at: b.latest,
        kind_hint: "spend_summary",
      });
    }
    for (const [dept, b] of reimbByDept) {
      if (signals.length >= limit) break;
      signals.push({
        external_id: `reimbursements:${dept}:${since.toISOString().slice(0, 10)}`,
        title: `Reimbursements · ${dept} · ${b.count} requests`,
        text: `Reimbursements since ${since.toISOString().slice(0, 10)}: ${b.count} requests, ${fmt(b.total)} total.`,
        url: "https://app.ramp.com/reimbursements",
        at: since.toISOString(),
        kind_hint: "spend_summary",
      });
    }
    for (const t of large.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, 20)) {
      if (signals.length >= limit) break;
      const when = t.user_transaction_time ?? t.settlement_date;
      signals.push({
        external_id: `transaction:${t.id}`,
        title: `${str(t.merchant_name) || "Transaction"} · ${fmt(t.amount ?? 0, t.currency_code)}`,
        text: [
          `Department: ${str(t.card_holder?.department_name) || "?"} · State: ${t.state ?? "?"}`,
          t.merchant_category_code_description ? `Category: ${t.merchant_category_code_description}` : null,
          t.memo ? `Memo: ${clip(t.memo, 1000)}` : null,
          t.receipts?.length ? `Receipts: ${t.receipts.length}` : "Receipt: missing",
        ]
          .filter(Boolean)
          .join("\n"),
        url: `https://app.ramp.com/transactions/${t.id}`,
        at: when ? new Date(when).toISOString() : since.toISOString(),
        kind_hint: "transaction",
      });
    }

    return { signals: signals.slice(0, limit), stats };
  },
};
