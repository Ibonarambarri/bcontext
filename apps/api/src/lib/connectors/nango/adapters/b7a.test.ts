/**
 * Batch 7a adapters — request shape + mapping against a fake proxy client.
 * QuickBooks, Xero, Shopify, Webflow, Contentful.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { contentfulAdapter, contentfulFieldsToText, contentfulRichTextToText, contentfulState } from "./contentful";
import { quickbooksAdapter, quickbooksQuery, quickbooksSinceLiteral } from "./quickbooks";
import { shopifyAdapter, shopifyNextPageInfo } from "./shopify";
import { webflowAdapter, webflowFieldsToText } from "./webflow";
import { xeroAdapter, xeroDate, xeroIfModifiedSince } from "./xero";

type Reply = unknown | { status: number; data: unknown; headers?: Record<string, string> };

function fakeClient(handler: (req: ProxyRequest) => Reply) {
  const calls: ProxyRequest[] = [];
  const client = {
    proxy: async (req: ProxyRequest): Promise<ProxyResponse> => {
      calls.push(req);
      const out = handler(req) as { status?: number; data?: unknown; headers?: Record<string, string> };
      const envelope = !!out && typeof out === "object" && typeof out.status === "number";
      const status = envelope ? out.status! : 200;
      const data = envelope ? out.data : out;
      return { status, ok: status < 400, data, headers: new Headers(envelope ? (out.headers ?? {}) : {}) };
    },
  } as unknown as NangoClient;
  return { client, calls };
}

const since = new Date("2026-09-01T00:00:00Z");
const base = { connectionId: "c1", connectionConfig: {}, config: {}, since, limit: 50 };

describe("quickbooks adapter", () => {
  it("builds the query literal with an offset and no milliseconds", () => {
    expect(quickbooksSinceLiteral(since)).toBe("2026-09-01T00:00:00+00:00");
    expect(quickbooksQuery("Invoice", since, 100)).toBe(
      "SELECT * FROM Invoice WHERE MetaData.LastUpdatedTime > '2026-09-01T00:00:00+00:00' ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 100",
    );
  });

  it("queries one entity at a time under the realm and rounds amounts", async () => {
    const { client, calls } = fakeClient((req) => {
      const q = String(req.query?.query);
      if (q.startsWith("SELECT * FROM Invoice")) {
        return {
          QueryResponse: {
            Invoice: [
              {
                Id: "1042",
                DocNumber: "INV-1042",
                TxnDate: "2026-09-02",
                DueDate: "2026-10-02",
                TotalAmt: 1234.56,
                Balance: 1234.56,
                CustomerRef: { value: "7", name: "Acme Corp" },
                CurrencyRef: { value: "EUR" },
                Line: [{ Description: "Consulting September", Amount: 1234.56, DetailType: "SalesItemLineDetail" }],
                MetaData: { LastUpdatedTime: "2026-09-02T10:00:00-07:00" },
              },
            ],
          },
        };
      }
      return { QueryResponse: {} };
    });
    const { signals, stats } = await quickbooksAdapter.fetchChanges({ client, ...base, connectionConfig: { realmId: "9341453474484455" }, config: { entities: ["invoice", "bill"] } });
    expect(calls.map((c) => c.path)).toEqual(["/v3/company/9341453474484455/query", "/v3/company/9341453474484455/query"]);
    expect(calls[0]?.headers?.Accept).toBe("application/json");
    expect(String(calls[1]?.query?.query)).toContain("FROM Bill");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("invoice:1042");
    expect(signals[0]?.title).toBe("Invoice #INV-1042 · Acme Corp");
    expect(signals[0]?.text).toContain("Total: ≈1235 EUR");
    expect(signals[0]?.text).toContain("- Consulting September · ≈1235 EUR");
    expect(signals[0]?.url).toBe("https://app.qbo.intuit.com/app/invoice?txnId=1042");
    expect(signals[0]?.at).toBe("2026-09-02T10:00:00-07:00");
    expect(stats).toEqual({ invoice: 1, bill: 0 });
  });

  it("reports a missing realm instead of calling the API", async () => {
    const { client, calls } = fakeClient(() => ({}));
    const out = await quickbooksAdapter.fetchChanges({ client, ...base });
    expect(calls).toHaveLength(0);
    expect(out.stats).toEqual({ missing_realm_id: 1 });
  });
});

describe("xero adapter", () => {
  it("parses /Date()/ and formats If-Modified-Since", () => {
    expect(xeroDate("/Date(1788307200000+0000)/")).toBe("2026-09-02T00:00:00.000Z");
    expect(xeroDate("2026-09-02T00:00:00")).toBe("2026-09-02T00:00:00.000Z");
    expect(xeroIfModifiedSince(since)).toBe("2026-09-01T00:00:00");
  });

  it("resolves the tenant, sends the tenant header and maps invoices and quotes", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/connections") return [{ tenantId: "t-1", tenantName: "Acme Ltd" }];
      if (req.path === "/api.xro/2.0/Invoices") {
        return {
          Invoices: [
            {
              InvoiceID: "inv-1",
              InvoiceNumber: "0042",
              Type: "ACCREC",
              Status: "AUTHORISED",
              Contact: { Name: "Globex" },
              Date: "/Date(1788307200000+0000)/",
              DueDate: "/Date(1790899200000+0000)/",
              Total: 900.4,
              AmountDue: 900.4,
              CurrencyCode: "GBP",
              LineItems: [{ Description: "Design sprint", LineAmount: 900.4 }],
              UpdatedDateUTC: "/Date(1788336000000+0000)/",
            },
            { InvoiceID: "inv-old", Type: "ACCPAY", Status: "PAID", UpdatedDateUTC: "/Date(1740000000000+0000)/" },
          ],
        };
      }
      if (req.path === "/api.xro/2.0/Quotes") {
        return { Quotes: [{ QuoteID: "q-1", QuoteNumber: "QU-7", Status: "SENT", Title: "Website refresh", Contact: { Name: "Initech" }, Total: 5000, CurrencyCode: "GBP", UpdatedDateUTC: "/Date(1788336000000+0000)/" }] };
      }
      if (req.path === "/api.xro/2.0/Contacts") return { Contacts: [] };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await xeroAdapter.fetchChanges({ client, ...base });
    expect(calls[1]?.headers).toMatchObject({ "xero-tenant-id": "t-1", "If-Modified-Since": "2026-09-01T00:00:00", Accept: "application/json" });
    expect(calls[1]?.query).toEqual({ order: "UpdatedDateUTC DESC", page: 1 });
    expect(signals.map((s) => s.external_id)).toEqual(["invoice:inv-1", "quote:q-1"]);
    expect(signals[0]?.title).toBe("Invoice #0042 · Globex");
    expect(signals[0]?.text).toContain("Type: Invoice (receivable) #0042 · Status: AUTHORISED");
    expect(signals[0]?.text).toContain("Total: ≈900 GBP");
    expect(signals[0]?.url).toBe("https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-1");
    expect(signals[0]?.at).toBe("2026-09-02T08:00:00.000Z");
    expect(signals[1]?.text).toContain("Title: Website refresh");
    expect(stats).toMatchObject({ invoices: 2, quotes: 1, contacts: 0 });
  });

  it("uses config.tenant_id without listing connections", async () => {
    const { client, calls } = fakeClient(() => ({ Invoices: [], Quotes: [], Contacts: [] }));
    await xeroAdapter.fetchChanges({ client, ...base, config: { tenant_id: "t-9", resources: ["invoices"] } });
    expect(calls.map((c) => c.path)).toEqual(["/api.xro/2.0/Invoices"]);
    expect(calls[0]?.headers?.["xero-tenant-id"]).toBe("t-9");
  });
});

describe("shopify adapter", () => {
  it("reads page_info from the Link header", () => {
    expect(shopifyNextPageInfo('<https://x.myshopify.com/admin/api/2024-10/orders.json?limit=100&page_info=abc%3D>; rel="next"')).toBe("abc=");
    expect(shopifyNextPageInfo('<https://x/orders.json?page_info=prev>; rel="previous"')).toBeNull();
    expect(shopifyNextPageInfo(null)).toBeNull();
  });

  it("filters by updated_at_min, follows Link paging with page_info only, and omits contact data", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/admin/api/2024-10/orders.json" && !req.query?.page_info) {
        return {
          status: 200,
          headers: { link: '<https://acme.myshopify.com/admin/api/2024-10/orders.json?limit=100&page_info=next1>; rel="next"' },
          data: {
            orders: [
              {
                id: 1001,
                name: "#1001",
                financial_status: "paid",
                fulfillment_status: null,
                total_price: "129.90",
                currency: "EUR",
                updated_at: "2026-09-03T09:00:00Z",
                note: "Gift wrap please",
                customer: { first_name: "Ana", last_name: "García", email: "ana@example.com" },
                line_items: [{ title: "Desk lamp", quantity: 2, price: "64.95" }],
              },
            ],
          },
        };
      }
      if (req.path === "/admin/api/2024-10/orders.json" && req.query?.page_info === "next1") {
        return { orders: [{ id: 1002, name: "#1002", financial_status: "refunded", total_price: "10.00", currency: "EUR", updated_at: "2026-09-02T09:00:00Z" }] };
      }
      if (req.path === "/admin/api/2024-10/products.json") {
        return { products: [{ id: 5, title: "Desk lamp", status: "active", vendor: "Lumen", body_html: "<p>Warm <b>LED</b></p>", updated_at: "2026-09-02T00:00:00Z", variants: [{ title: "Black", price: "64.95", inventory_quantity: 12 }] }] };
      }
      if (req.path === "/admin/api/2024-10/customers.json") return { customers: [] };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await shopifyAdapter.fetchChanges({ client, ...base, connectionConfig: { subdomain: "acme" } });
    expect(calls[0]?.query).toEqual({ limit: 100, updated_at_min: "2026-09-01T00:00:00.000Z", status: "any" });
    expect(calls[1]?.query).toEqual({ limit: 100, page_info: "next1" });
    expect(calls[2]?.query).toEqual({ limit: 100, updated_at_min: "2026-09-01T00:00:00.000Z" });
    expect(signals.map((s) => s.external_id)).toEqual(["order:1001", "order:1002", "product:5"]);
    expect(signals[0]?.title).toBe("Order #1001 · Ana García");
    expect(signals[0]?.text).toContain("Total: ≈130 EUR");
    expect(signals[0]?.text).toContain("- 2× Desk lamp · ≈65 EUR");
    expect(signals[0]?.text).not.toContain("ana@example.com");
    expect(signals[0]?.url).toBe("https://admin.shopify.com/store/acme/orders/1001");
    expect(signals[2]?.text).toContain("Description: Warm LED");
    expect(signals[2]?.text).toContain("- Black · ≈65 · stock 12");
    expect(stats).toEqual({ orders: 2, products: 1, customers: 0 });
  });
});

describe("webflow adapter", () => {
  it("flattens field data and strips HTML", () => {
    expect(webflowFieldsToText({ name: "Post", slug: "post", body: "<p>Hello <b>there</b></p>", tags: ["a", "b"], image: { url: "https://x/img.png" }, empty: "" })).toBe(
      "name: Post\nbody: Hello there\ntags: a, b\nimage: https://x/img.png",
    );
  });

  it("walks sites → collections → items and pages, keeping only changes after since", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v2/sites") return { sites: [{ id: "s1", displayName: "Acme", shortName: "acme" }] };
      if (req.path === "/v2/sites/s1/collections") return { collections: [{ id: "col1", displayName: "Blog", slug: "blog" }] };
      if (req.path === "/v2/collections/col1/items") {
        return {
          items: [
            { id: "i1", lastUpdated: "2026-09-04T00:00:00Z", lastPublished: "2026-09-04T01:00:00Z", isDraft: false, fieldData: { name: "Launch notes", slug: "launch-notes", body: "<p>We shipped v2.</p>" } },
            { id: "i0", lastUpdated: "2026-08-01T00:00:00Z", fieldData: { name: "Old", slug: "old" } },
          ],
          pagination: { limit: 100, offset: 0, total: 2 },
        };
      }
      if (req.path === "/v2/sites/s1/pages") return { pages: [{ id: "p1", title: "Pricing", slug: "pricing", lastUpdated: "2026-09-05T00:00:00Z", publishedPath: "/pricing", seo: { description: "Plans" } }] };
      return { status: 500, data: {} };
    });
    const { signals, stats } = await webflowAdapter.fetchChanges({ client, ...base });
    expect(calls.map((c) => c.path)).toEqual(["/v2/sites", "/v2/sites/s1/collections", "/v2/collections/col1/items", "/v2/sites/s1/pages"]);
    expect(calls[2]?.query).toEqual({ limit: 100, offset: 0 });
    expect(signals.map((s) => s.external_id)).toEqual(["item:col1:i1", "page:p1"]);
    expect(signals[0]?.title).toBe("Blog · Launch notes");
    expect(signals[0]?.text).toContain("State: published");
    expect(signals[0]?.text).toContain("body: We shipped v2.");
    expect(signals[0]?.url).toBe("https://acme.webflow.io/blog/launch-notes");
    expect(signals[1]?.url).toBe("https://acme.webflow.io/pricing");
    expect(signals[1]?.text).toContain("SEO description: Plans");
    expect(stats).toEqual({ sites: 1, collections: 1, items: 1, pages: 1 });
  });
});

describe("contentful adapter", () => {
  it("flattens rich text and localised fields, and derives the publish state", () => {
    const doc = { nodeType: "document", content: [{ nodeType: "paragraph", content: [{ nodeType: "text", value: "Hello " }, { nodeType: "text", value: "world" }] }] };
    expect(contentfulRichTextToText(doc)).toBe("Hello world\n");
    expect(contentfulFieldsToText({ title: { "en-US": "Launch", es: "Lanzamiento" }, body: { "en-US": doc }, ref: { "en-US": { sys: { type: "Link", linkType: "Asset", id: "a1" } } } })).toBe(
      "title: Launch\nbody: Hello world\nref: [link → Asset a1]",
    );
    expect(contentfulState({ id: "e", publishedAt: "2026-09-01T00:00:00Z", publishedVersion: 3, version: 4 })).toBe("published");
    expect(contentfulState({ id: "e", publishedAt: "2026-09-01T00:00:00Z", publishedVersion: 3, version: 6 })).toBe("changed");
    expect(contentfulState({ id: "e" })).toBe("draft");
  });

  it("picks the first space when none is configured and queries entries updated since", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/spaces") return { items: [{ sys: { id: "sp1" }, name: "Marketing" }] };
      if (req.path === "/spaces/sp1/environments/master/entries") {
        return {
          total: 1,
          items: [
            {
              sys: { id: "e1", updatedAt: "2026-09-03T12:00:00Z", publishedAt: "2026-09-03T12:00:00Z", version: 2, publishedVersion: 1, contentType: { sys: { id: "blogPost" } }, updatedBy: { sys: { id: "u1" } } },
              fields: { title: { "en-US": "Pricing update" }, body: { "en-US": { nodeType: "document", content: [{ nodeType: "paragraph", content: [{ nodeType: "text", value: "Prices rise 5% in October." }] }] } } },
            },
          ],
        };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await contentfulAdapter.fetchChanges({ client, ...base });
    expect(calls[1]?.query).toEqual({ "sys.updatedAt[gte]": "2026-09-01T00:00:00.000Z", order: "-sys.updatedAt", limit: 100, skip: 0 });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("entry:e1");
    expect(signals[0]?.title).toBe("blogPost · Pricing update");
    expect(signals[0]?.text).toContain("Content type: blogPost · State: published");
    expect(signals[0]?.text).toContain("body: Prices rise 5% in October.");
    expect(signals[0]?.url).toBe("https://app.contentful.com/spaces/sp1/environments/master/entries/e1");
    expect(signals[0]?.author).toBe("u1");
    expect(signals[0]?.at).toBe("2026-09-03T12:00:00Z");
    expect(stats).toEqual({ scanned: 1 });
  });
});
