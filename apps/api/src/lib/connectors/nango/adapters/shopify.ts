/**
 * Shopify — `shopify` → Nango `shopify-api-key` (API_KEY: an Admin API access
 * token; connection_config.subdomain is the `*.myshopify.com` store handle).
 *
 * Admin REST 2024-10, `updated_at_min` on orders, products and customers (or
 * the `config.resources` allow-list), newest first, up to 3 pages of 100
 * through the `Link: <…page_info=…>; rel="next"` header. Once a request
 * carries `page_info` Shopify rejects every other filter, so continuation
 * requests send `limit` + `page_info` only.
 *
 * Money is rounded to whole currency units; customer emails, phones and
 * addresses are never copied — names and order-level facts are enough for
 * "what did the business decide / what is going wrong".
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, htmlToText, str, subdomain, type NangoAdapter } from "./shared";

const API = "/admin/api/2024-10";
export const SHOPIFY_RESOURCES = ["orders", "products", "customers"] as const;
type ShopifyResource = (typeof SHOPIFY_RESOURCES)[number];

interface ShopifyLineItem {
  title?: string;
  quantity?: number;
  price?: string;
  sku?: string;
}
interface ShopifyOrder {
  id: number;
  name?: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  total_price?: string;
  currency?: string;
  created_at?: string;
  updated_at?: string;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  note?: string | null;
  tags?: string;
  line_items?: ShopifyLineItem[];
  customer?: { first_name?: string | null; last_name?: string | null };
  discount_codes?: Array<{ code?: string }>;
}
interface ShopifyVariant {
  title?: string;
  price?: string;
  inventory_quantity?: number;
}
interface ShopifyProduct {
  id: number;
  title?: string;
  status?: string;
  product_type?: string;
  vendor?: string;
  tags?: string;
  handle?: string;
  body_html?: string | null;
  updated_at?: string;
  variants?: ShopifyVariant[];
}
interface ShopifyCustomer {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  state?: string;
  orders_count?: number;
  total_spent?: string;
  currency?: string;
  tags?: string;
  note?: string | null;
  updated_at?: string;
}

/** `<url?page_info=abc&limit=100>; rel="next"` → `abc` (or null). */
export function shopifyNextPageInfo(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const m = /[?&]page_info=([^&>]+)/.exec(part);
    if (m) return decodeURIComponent(m[1]!);
  }
  return null;
}

function money(amount: string | number | undefined, currency?: string): string | null {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (typeof n !== "number" || Number.isNaN(n)) return null;
  return `≈${Math.round(n)} ${currency ?? ""}`.trim();
}

function customerName(c: ShopifyOrder["customer"] | ShopifyCustomer | undefined): string | null {
  if (!c) return null;
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

export function shopifyOrderText(o: ShopifyOrder): string {
  const lines: Array<string | null> = [
    `Order ${o.name ?? o.id} · Payment: ${o.financial_status ?? "?"} · Fulfillment: ${o.fulfillment_status ?? "unfulfilled"}`,
    customerName(o.customer) ? `Customer: ${customerName(o.customer)}` : null,
    money(o.total_price, o.currency) ? `Total: ${money(o.total_price, o.currency)}` : null,
    o.cancelled_at ? `Cancelled: ${o.cancelled_at}${o.cancel_reason ? ` (${o.cancel_reason})` : ""}` : null,
    o.discount_codes?.length ? `Discount codes: ${o.discount_codes.map((d) => d.code).filter(Boolean).join(", ")}` : null,
    o.tags ? `Tags: ${o.tags}` : null,
    o.note ? `Note: ${o.note}` : null,
  ];
  const items = (o.line_items ?? []).slice(0, 15).map((l) => `- ${l.quantity ?? 1}× ${l.title ?? l.sku ?? "(item)"}${money(l.price, o.currency) ? ` · ${money(l.price, o.currency)}` : ""}`);
  if (items.length) lines.push("", "Items:", ...items);
  return clip(lines.filter((l): l is string => l !== null).join("\n"));
}

export function shopifyProductText(p: ShopifyProduct): string {
  const variants = (p.variants ?? []).slice(0, 10).map((v) => `- ${v.title ?? "Default"}${money(v.price) ? ` · ${money(v.price)}` : ""}${typeof v.inventory_quantity === "number" ? ` · stock ${v.inventory_quantity}` : ""}`);
  const lines: Array<string | null> = [
    `Product: ${p.title ?? p.id} · Status: ${p.status ?? "?"}`,
    p.product_type ? `Type: ${p.product_type}` : null,
    p.vendor ? `Vendor: ${p.vendor}` : null,
    p.tags ? `Tags: ${p.tags}` : null,
    p.body_html ? `Description: ${clip(htmlToText(p.body_html), 1500)}` : null,
  ];
  if (variants.length) lines.push("", "Variants:", ...variants);
  return clip(lines.filter((l): l is string => l !== null).join("\n"));
}

export function shopifyCustomerText(c: ShopifyCustomer): string {
  return [
    `Customer: ${customerName(c) ?? c.id} · State: ${c.state ?? "?"}`,
    typeof c.orders_count === "number" ? `Orders: ${c.orders_count}${money(c.total_spent, c.currency) ? ` · Spent: ${money(c.total_spent, c.currency)}` : ""}` : null,
    c.tags ? `Tags: ${c.tags}` : null,
    c.note ? `Note: ${c.note}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export const shopifyAdapter: NangoAdapter = {
  id: "shopify",
  provider: "shopify-api-key",
  sourceHint: "shopify:admin",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const store = subdomain(connectionConfig);
    const admin = store ? `https://admin.shopify.com/store/${store}` : null;
    const wanted = allowList(config, "resources");
    const resources = SHOPIFY_RESOURCES.filter((r) => !wanted || wanted.map((w) => w.toLowerCase()).includes(r));
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = {};

    for (const resource of resources) {
      let pageInfo: string | null = null;
      for (let page = 0; page < 3 && signals.length < limit; page += 1) {
        const res = await client.proxy<Record<string, unknown[]>>({
          method: "GET",
          providerConfigKey: "shopify",
          connectionId,
          path: `${API}/${resource}.json`,
          query: pageInfo
            ? { limit: 100, page_info: pageInfo }
            : { limit: 100, updated_at_min: since.toISOString(), ...(resource === "orders" ? { status: "any" } : {}) },
        });
        if (!res.ok) throw new Error(`shopify ${resource} failed (${res.status})`);
        const rows = (res.data?.[resource] ?? []) as unknown[];
        stats[resource] = (stats[resource] ?? 0) + rows.length;
        for (const raw of rows) {
          if (resource === "orders") {
            const o = raw as ShopifyOrder;
            signals.push({
              external_id: `order:${o.id}`,
              title: `Order ${o.name ?? o.id}${customerName(o.customer) ? ` · ${customerName(o.customer)}` : ""}`,
              text: shopifyOrderText(o),
              url: admin ? `${admin}/orders/${o.id}` : undefined,
              at: o.updated_at,
              kind_hint: "order",
            });
          } else if (resource === "products") {
            const p = raw as ShopifyProduct;
            signals.push({
              external_id: `product:${p.id}`,
              title: `Product · ${p.title ?? p.id}`,
              text: shopifyProductText(p),
              url: admin ? `${admin}/products/${p.id}` : undefined,
              at: p.updated_at,
              kind_hint: "product",
            });
          } else {
            const c = raw as ShopifyCustomer;
            signals.push({
              external_id: `customer:${c.id}`,
              title: `Customer · ${customerName(c) ?? str(c.id)}`,
              text: shopifyCustomerText(c),
              url: admin ? `${admin}/customers/${c.id}` : undefined,
              at: c.updated_at,
              kind_hint: "customer",
            });
          }
          if (signals.length >= limit) break;
        }
        pageInfo = shopifyNextPageInfo(res.headers.get("link"));
        if (!pageInfo) break;
      }
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
