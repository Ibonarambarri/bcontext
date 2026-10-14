/**
 * Brex — `brex` → Nango `brex` (OAuth2; proxy https://platform.brexapis.com).
 *
 * Card expenses updated since the cursor (`GET /v1/expenses/card` with
 * `expand[]=merchant,department`) are aggregated per department and
 * merchant, large ones get their own signal with memo and receipt status;
 * posted card transactions (`GET /v2/transactions/card/primary`) give the
 * period total per merchant as a cross-check. Amounts arrive in minor
 * units (cents) and are rendered rounded in major units. No card data, no
 * user emails.
 *
 * Pagination: both endpoints return `{ items, next_cursor }`.
 * `config.large_threshold` (major units, default 1000) and
 * `config.departments` (allow-list).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, str, type NangoAdapter } from "./shared";

interface Money {
  amount?: number;
  currency?: string;
}

interface BrexExpense {
  id: string;
  updated_at?: string;
  purchased_at?: string;
  status?: string;
  payment_status?: string;
  memo?: string | null;
  merchant?: { raw_descriptor?: string; mcc?: string } | null;
  department?: { name?: string } | null;
  department_id?: string | null;
  original_amount?: Money;
  billing_amount?: Money;
  purchased_amount?: Money;
  receipts?: unknown[];
  category?: string;
}

interface BrexTransaction {
  id: string;
  description?: string;
  amount?: Money;
  initiated_at_date?: string;
  posted_at_date?: string;
  merchant?: { raw_descriptor?: string } | null;
  expense_id?: string;
}

interface BrexPage<T> {
  items?: T[];
  next_cursor?: string | null;
}

const MAX_PAGES = 5;

function major(m?: Money): number {
  return typeof m?.amount === "number" ? m.amount / 100 : 0;
}

function fmt(n: number, currency = "USD"): string {
  return `${Math.round(n).toLocaleString("en-US")} ${currency}`;
}

export const brexAdapter: NangoAdapter = {
  id: "brex",
  provider: "brex",
  sourceHint: "brex:spend",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const departmentsAllow = allowList(config, "departments");
    const rawThreshold = config.large_threshold;
    const threshold = typeof rawThreshold === "number" && rawThreshold > 0 ? rawThreshold : 1000;
    const stats: Record<string, number> = { expenses: 0, transactions: 0 };
    const signals: IngestSignal[] = [];

    // -- expenses (memo, department, receipt status) ----------------------------
    const expenses: BrexExpense[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.proxy<BrexPage<BrexExpense>>({
        method: "GET",
        providerConfigKey: "brex",
        connectionId,
        path: "/v1/expenses/card",
        query: {
          updated_at_start: since.toISOString(),
          "expand[]": "merchant",
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
      });
      if (!res.ok) throw new Error(`brex expenses failed (${res.status})`);
      expenses.push(...(res.data?.items ?? []));
      cursor = res.data?.next_cursor ?? undefined;
      if (!cursor) break;
    }

    interface Bucket {
      total: number;
      count: number;
      currency: string;
      merchants: Map<string, number>;
      latest: string;
      missingReceipts: number;
      statuses: Map<string, number>;
    }
    const byDept = new Map<string, Bucket>();
    const large: BrexExpense[] = [];
    for (const e of expenses) {
      const dept = str(e.department?.name || e.department_id) || "no department";
      if (departmentsAllow && !departmentsAllow.includes(dept)) continue;
      stats.expenses = (stats.expenses ?? 0) + 1;
      const money = e.billing_amount ?? e.purchased_amount ?? e.original_amount;
      const amount = major(money);
      const when = e.updated_at ?? e.purchased_at ?? since.toISOString();
      const b = byDept.get(dept) ?? { total: 0, count: 0, currency: money?.currency ?? "USD", merchants: new Map(), latest: when, missingReceipts: 0, statuses: new Map() };
      b.total += amount;
      b.count++;
      const merchant = str(e.merchant?.raw_descriptor) || "unknown merchant";
      b.merchants.set(merchant, (b.merchants.get(merchant) ?? 0) + amount);
      if (when > b.latest) b.latest = when;
      if (!e.receipts?.length) b.missingReceipts++;
      const status = e.status ?? "?";
      b.statuses.set(status, (b.statuses.get(status) ?? 0) + 1);
      byDept.set(dept, b);
      if (amount >= threshold) large.push(e);
    }

    // -- posted transactions per merchant (cross-check totals) -------------------
    const txByMerchant = new Map<string, { total: number; count: number; currency: string }>();
    cursor = undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: Awaited<ReturnType<typeof client.proxy<BrexPage<BrexTransaction>>>> = await client.proxy<BrexPage<BrexTransaction>>({
        method: "GET",
        providerConfigKey: "brex",
        connectionId,
        path: "/v2/transactions/card/primary",
        query: { posted_at_start: since.toISOString(), limit: 100, ...(cursor ? { cursor } : {}) },
      });
      if (!res.ok) {
        stats.transactions_unavailable = 1;
        break;
      }
      for (const t of res.data?.items ?? []) {
        stats.transactions = (stats.transactions ?? 0) + 1;
        const merchant = str(t.merchant?.raw_descriptor || t.description) || "unknown merchant";
        const b = txByMerchant.get(merchant) ?? { total: 0, count: 0, currency: t.amount?.currency ?? "USD" };
        b.total += major(t.amount);
        b.count++;
        txByMerchant.set(merchant, b);
      }
      cursor = res.data?.next_cursor ?? undefined;
      if (!cursor) break;
    }

    const day = since.toISOString().slice(0, 10);
    for (const [dept, b] of byDept) {
      if (signals.length >= limit) break;
      const top = [...b.merchants.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 10)
        .map(([m, v]) => `${m}: ${fmt(v, b.currency)}`)
        .join(", ");
      const statuses = [...b.statuses.entries()].map(([s, n]) => `${s} ×${n}`).join(", ");
      signals.push({
        external_id: `spend:${dept}:${day}`,
        title: `Spend · ${dept} · ${fmt(b.total, b.currency)} across ${b.count} expenses`,
        text: [
          `Period: since ${day} · Expenses: ${b.count} · Total: ${fmt(b.total, b.currency)}`,
          top ? `Top merchants: ${top}` : null,
          statuses ? `Statuses: ${statuses}` : null,
          b.missingReceipts ? `Missing receipts: ${b.missingReceipts}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        url: "https://dashboard.brex.com/p/expenses",
        at: b.latest,
        kind_hint: "spend_summary",
      });
    }
    if (txByMerchant.size && signals.length < limit) {
      const total = [...txByMerchant.values()].reduce((s, b) => s + b.total, 0);
      const currency = [...txByMerchant.values()][0]?.currency ?? "USD";
      const top = [...txByMerchant.entries()]
        .sort((x, y) => y[1].total - x[1].total)
        .slice(0, 15)
        .map(([m, b]) => `${m}: ${fmt(b.total, b.currency)} (${b.count})`)
        .join(", ");
      signals.push({
        external_id: `posted:${day}`,
        title: `Posted card transactions · ${fmt(total, currency)}`,
        text: `Posted since ${day}: ${stats.transactions} transactions, ${fmt(total, currency)}.\nTop merchants: ${top}`,
        url: "https://dashboard.brex.com/p/transactions",
        at: since.toISOString(),
        kind_hint: "spend_summary",
      });
    }
    for (const e of large.sort((a, b) => major(b.billing_amount ?? b.purchased_amount) - major(a.billing_amount ?? a.purchased_amount)).slice(0, 20)) {
      if (signals.length >= limit) break;
      const money = e.billing_amount ?? e.purchased_amount ?? e.original_amount;
      signals.push({
        external_id: `expense:${e.id}`,
        title: `${str(e.merchant?.raw_descriptor) || "Expense"} · ${fmt(major(money), money?.currency)}`,
        text: [
          `Department: ${str(e.department?.name || e.department_id) || "?"} · Status: ${e.status ?? "?"}${e.payment_status ? ` · Payment: ${e.payment_status}` : ""}`,
          e.category ? `Category: ${e.category}` : null,
          e.memo ? `Memo: ${clip(e.memo, 1000)}` : null,
          e.receipts?.length ? `Receipts: ${e.receipts.length}` : "Receipt: missing",
        ]
          .filter(Boolean)
          .join("\n"),
        url: `https://dashboard.brex.com/p/expenses/${e.id}`,
        at: e.updated_at ?? e.purchased_at ?? since.toISOString(),
        kind_hint: "expense",
      });
    }

    return { signals: signals.slice(0, limit), stats };
  },
};
