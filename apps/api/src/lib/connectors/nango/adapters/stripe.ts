/**
 * Stripe — `stripe` → Nango `stripe-api-key` (BASIC: the restricted/secret
 * key as username; proxy base https://api.stripe.com). Read-only: the
 * `/v1/events` feed since the cursor, kept to the business-relevant types
 * (subscriptions, invoices, disputes, refunds, products, prices, coupons,
 * checkout) or `config.event_types` (exact types or `prefix.*`). Each event is
 * summarised without card data and with amounts rounded to whole currency
 * units — NEXO needs "plan changed, invoice failed, dispute opened", not
 * cents.
 *
 * Assumption: `created[gte]` + `starting_after` cursor pagination on
 * `/v1/events` (newest first), at most 3 pages of 100 per run.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, epochSeconds, str, type NangoAdapter } from "./shared";

interface StripeObject {
  id?: string;
  object?: string;
  status?: string;
  amount?: number;
  amount_due?: number;
  amount_paid?: number;
  amount_total?: number;
  currency?: string;
  customer?: string | { id?: string; email?: string; name?: string };
  customer_email?: string;
  customer_name?: string;
  name?: string;
  nickname?: string;
  reason?: string;
  description?: string | null;
  cancel_at_period_end?: boolean;
  items?: { data?: Array<{ price?: { nickname?: string | null; product?: string; unit_amount?: number | null; currency?: string; recurring?: { interval?: string } } }> };
  plan?: { nickname?: string | null; interval?: string };
  product?: string;
  unit_amount?: number | null;
  recurring?: { interval?: string };
  percent_off?: number | null;
  amount_off?: number | null;
}
interface StripeEvent {
  id: string;
  type?: string;
  created?: number;
  data?: { object?: StripeObject; previous_attributes?: Record<string, unknown> };
}

export const STRIPE_DEFAULT_EVENT_TYPES = [
  "customer.subscription.*",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.finalized",
  "charge.dispute.*",
  "charge.refunded",
  "checkout.session.completed",
  "customer.created",
  "product.*",
  "price.*",
  "coupon.*",
];

export function stripeTypeAllowed(type: string, allowed: string[]): boolean {
  return allowed.some((rule) => (rule.endsWith(".*") ? type.startsWith(rule.slice(0, -1)) : type === rule));
}

/** Cents → whole currency units, e.g. 12990 "eur" → "≈130 EUR". */
export function stripeAmount(cents: number | null | undefined, currency?: string): string | null {
  if (typeof cents !== "number") return null;
  return `≈${Math.round(cents / 100)} ${(currency ?? "").toUpperCase()}`.trim();
}

function customerOf(o: StripeObject): string | null {
  if (o.customer && typeof o.customer === "object") return o.customer.name ?? o.customer.email ?? o.customer.id ?? null;
  return o.customer_name ?? o.customer_email ?? (typeof o.customer === "string" ? o.customer : null);
}

export function stripeEventText(ev: StripeEvent): string {
  const o = ev.data?.object ?? {};
  const lines: Array<string | null> = [`Event: ${ev.type ?? "?"} · Object: ${o.object ?? "?"} ${o.id ?? ""}`.trim()];
  if (o.status) lines.push(`Status: ${o.status}`);
  const customer = customerOf(o);
  if (customer) lines.push(`Customer: ${customer}`);
  const amount = stripeAmount(o.amount_total ?? o.amount_paid ?? o.amount_due ?? o.amount ?? o.unit_amount ?? o.amount_off, o.currency);
  if (amount) lines.push(`Amount: ${amount}`);
  if (typeof o.percent_off === "number") lines.push(`Discount: ${o.percent_off}%`);
  const plan = o.items?.data?.[0]?.price ?? o.plan;
  if (plan) {
    const price = "unit_amount" in plan ? stripeAmount(plan.unit_amount, plan.currency) : null;
    const interval = "recurring" in plan ? plan.recurring?.interval : (plan as { interval?: string }).interval;
    lines.push(`Plan: ${plan.nickname ?? ("product" in plan ? plan.product : "") ?? "?"}${price ? ` · ${price}` : ""}${interval ? `/${interval}` : ""}`);
  }
  if (o.cancel_at_period_end) lines.push("Cancels at period end.");
  if (o.name && o.object !== "customer") lines.push(`Name: ${o.name}`);
  if (o.nickname) lines.push(`Nickname: ${o.nickname}`);
  if (o.reason) lines.push(`Reason: ${o.reason}`);
  if (o.description) lines.push(`Description: ${o.description}`);
  const changed = Object.keys(ev.data?.previous_attributes ?? {});
  if (changed.length) lines.push(`Changed fields: ${changed.join(", ")}`);
  return lines.filter((l): l is string => !!l).join("\n");
}

export const stripeAdapter: NangoAdapter = {
  id: "stripe",
  provider: "stripe-api-key",
  sourceHint: "stripe:events",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const allowed = allowList(config, "event_types") ?? STRIPE_DEFAULT_EVENT_TYPES;
    const signals: IngestSignal[] = [];
    let startingAfter: string | undefined;
    let pages = 0;
    let scanned = 0;
    do {
      const res = await client.proxy<{ data?: StripeEvent[]; has_more?: boolean }>({
        method: "GET",
        providerConfigKey: "stripe",
        connectionId,
        path: "/v1/events",
        query: { "created[gte]": epochSeconds(since), limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      });
      if (!res.ok) throw new Error(`stripe events failed (${res.status})`);
      const events = res.data?.data ?? [];
      pages += 1;
      for (const ev of events) {
        scanned += 1;
        if (!ev.type || !stripeTypeAllowed(ev.type, allowed)) continue;
        const o = ev.data?.object ?? {};
        signals.push({
          external_id: `event:${ev.id}`,
          title: `${ev.type}${o.id ? ` · ${o.id}` : ""}`,
          text: stripeEventText(ev),
          url: `https://dashboard.stripe.com/events/${ev.id}`,
          at: ev.created ? new Date(ev.created * 1000).toISOString() : undefined,
          kind_hint: str(ev.type.split(".")[0]),
        });
        if (signals.length >= limit) break;
      }
      startingAfter = res.data?.has_more && events.length ? events[events.length - 1]?.id : undefined;
    } while (startingAfter && signals.length < limit && pages < 3);
    return { signals: signals.slice(0, limit), stats: { pages, scanned } };
  },
};
