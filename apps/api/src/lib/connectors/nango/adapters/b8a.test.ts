/**
 * Batch 8a adapters — request shape + mapping against a fake proxy client.
 * Front, Gorgias, Help Scout, WhatsApp Business, LinkedIn.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { frontAdapter, frontSearchQuery } from "./front";
import { gorgiasAdapter } from "./gorgias";
import { helpscoutAdapter } from "./helpscout";
import { LINKEDIN_HEADERS, linkedinAdapter, postUrl } from "./linkedin";
import { GRAPH_VERSION, templateText, whatsappAdapter } from "./whatsapp";

type Reply = unknown | { status: number; data: unknown };

function fakeClient(handler: (req: ProxyRequest) => Reply) {
  const calls: ProxyRequest[] = [];
  const client = {
    proxy: async (req: ProxyRequest): Promise<ProxyResponse> => {
      calls.push(req);
      const out = handler(req) as { status?: number; data?: unknown };
      const envelope = !!out && typeof out === "object" && typeof out.status === "number";
      const status = envelope ? out.status! : 200;
      const data = envelope ? out.data : out;
      return { status, ok: status < 400, data, headers: new Headers() };
    },
  } as unknown as NangoClient;
  return { client, calls };
}

const since = new Date("2026-09-01T00:00:00Z");
const base = { connectionId: "c1", connectionConfig: {}, config: {}, since, limit: 50 };

describe("front adapter", () => {
  it("searches conversations updated after since, scoped to inboxes, and attaches messages + comments", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path.startsWith("/conversations/search/")) {
        return {
          _results: [
            { id: "cnv_1", subject: "Refund for order 42", status: "assigned", assignee: { first_name: "Ana", last_name: "Ruiz" }, tags: [{ name: "billing" }], last_message: { created_at: 1788300000 } },
          ],
          _pagination: { next: null },
        };
      }
      if (req.path === "/conversations/cnv_1/messages") {
        return { _results: [{ id: "m1", is_inbound: true, created_at: 1788290000, author: null, body: "<p>I want a refund</p>" }, { id: "m2", is_inbound: false, created_at: 1788300000, author: { first_name: "Ana" }, text: "Done, refunded" }] };
      }
      if (req.path === "/conversations/cnv_1/comments") {
        return { _results: [{ id: "cm1", author: { first_name: "Bo" }, body: "Customer is a VIP", posted_at: 1788295000 }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await frontAdapter.fetchChanges({ client, ...base, config: { inbox_ids: ["inb_9"] } });
    expect(decodeURIComponent(calls[0]!.path)).toBe(`/conversations/search/updated_after:${Math.floor(since.getTime() / 1000)} inbox:inb_9`);
    expect(calls[0]?.query?.limit).toBe(50);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ external_id: "conversation:cnv_1", title: "Refund for order 42", url: "https://app.frontapp.com/open/cnv_1", author: "Ana Ruiz", kind_hint: "conversation" });
    expect(signals[0]?.at).toBe(new Date(1788300000 * 1000).toISOString());
    expect(signals[0]?.text).toContain("Assignee: Ana Ruiz · Tags: billing");
    expect(signals[0]?.text).toContain("customer (");
    expect(signals[0]?.text).toContain("I want a refund");
    expect(signals[0]?.text).toContain("Internal comments:");
    expect(signals[0]?.text).toContain("Bo (");
    expect(stats).toMatchObject({ pages: 1, conversations: 1, detailed: 1 });
    expect(frontSearchQuery(since, null)).toBe(`updated_after:${Math.floor(since.getTime() / 1000)}`);
  });
});

describe("gorgias adapter", () => {
  it("walks tickets newest first, stops at the cursor, filters channels and reads messages", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/tickets") {
        return {
          data: [
            { id: 11, subject: "Broken zipper", status: "open", channel: "email", tags: [{ name: "quality" }], assignee_user: { name: "Ana" }, updated_datetime: "2026-09-03T10:00:00Z" },
            { id: 12, subject: "Chat", status: "closed", channel: "chat", updated_datetime: "2026-09-02T10:00:00Z" },
            { id: 10, subject: "Old", status: "closed", channel: "email", updated_datetime: "2026-08-20T10:00:00Z" },
          ],
          meta: { next_cursor: "abc" },
        };
      }
      if (req.path === "/api/tickets/11/messages") {
        return { data: [{ id: 2, from_agent: true, sender: { name: "Ana" }, body_text: "Sending a replacement", created_datetime: "2026-09-03T10:00:00Z" }, { id: 1, from_agent: false, body_html: "<p>The zipper broke</p>", created_datetime: "2026-09-03T09:00:00Z" }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await gorgiasAdapter.fetchChanges({ client, ...base, connectionConfig: { subdomain: "acme" }, config: { channels: ["email"] } });
    expect(calls[0]?.query).toMatchObject({ order_by: "updated_datetime:desc", limit: 50 });
    // The older ticket stopped pagination even though a cursor was returned.
    expect(calls.filter((c) => c.path === "/api/tickets")).toHaveLength(1);
    expect(signals.map((s) => s.external_id)).toEqual(["ticket:11"]);
    expect(signals[0]).toMatchObject({ title: "#11 · Broken zipper", url: "https://acme.gorgias.com/app/ticket/11", author: "Ana", at: "2026-09-03T10:00:00Z" });
    expect(signals[0]?.text).toContain("Channel: email");
    expect(signals[0]?.text).toContain("customer (2026-09-03T09:00:00Z): The zipper broke");
    expect(signals[0]?.text).toContain("Ana (2026-09-03T10:00:00Z): Sending a replacement");
    expect(stats).toMatchObject({ pages: 1, tickets: 1, detailed: 1 });
  });
});

describe("helpscout adapter", () => {
  it("lists conversations modified since with embedded threads, per mailbox", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v2/conversations") {
        return {
          _embedded: {
            conversations: [
              {
                id: 501, number: 77, subject: "Invoice question", status: "active", type: "email", assignee: { first: "Ana", last: "Ruiz" }, tags: [{ tag: "billing" }], userUpdatedAt: "2026-09-02T12:00:00Z",
                _embedded: { threads: [{ id: 1, type: "customer", body: "<p>Where is my invoice?</p>", createdAt: "2026-09-02T11:00:00Z", createdBy: { first: "Cli", last: "Ent", type: "customer" } }, { id: 2, type: "message", body: "Attached", createdAt: "2026-09-02T12:00:00Z", createdBy: { first: "Ana", type: "user" } }] },
              },
            ],
          },
          page: { number: 1, totalPages: 1 },
        };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await helpscoutAdapter.fetchChanges({ client, ...base, config: { mailbox_ids: ["123"] } });
    expect(calls[0]?.query).toMatchObject({ modifiedSince: since.toISOString(), status: "all", sortField: "modifiedAt", sortOrder: "desc", embed: "threads", page: 1, mailbox: "123" });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ external_id: "conversation:501", title: "#77 · Invoice question", url: "https://secure.helpscout.net/conversation/501/77", author: "Ana Ruiz", at: "2026-09-02T12:00:00Z" });
    expect(signals[0]?.text).toContain("Cli Ent (2026-09-02T11:00:00Z): Where is my invoice?");
    expect(stats).toMatchObject({ pages: 1, mailboxes: 1 });
  });
});

describe("whatsapp adapter", () => {
  it("returns nothing without a waba_id", async () => {
    const { client, calls } = fakeClient(() => ({}));
    const out = await whatsappAdapter.fetchChanges({ client, ...base });
    expect(out.signals).toEqual([]);
    expect(out.stats).toEqual({ missing_waba_id: 1 });
    expect(calls).toHaveLength(0);
  });

  it("reads phone numbers and templates, stamped at since with stable ids", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === `/${GRAPH_VERSION}/waba1/phone_numbers`) {
        return { data: [{ id: "p1", display_phone_number: "+34 600 000 000", verified_name: "Acme", quality_rating: "GREEN", name_status: "APPROVED" }] };
      }
      if (req.path === `/${GRAPH_VERSION}/waba1/message_templates`) {
        return { data: [{ id: "t1", name: "order_update", status: "APPROVED", category: "UTILITY", language: "es", components: [{ type: "HEADER", format: "TEXT", text: "Pedido {{1}}" }, { type: "BODY", text: "Tu pedido va en camino" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "Seguir", url: "https://acme.test/track" }] }] }], paging: { cursors: { after: "x" } } };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await whatsappAdapter.fetchChanges({ client, ...base, config: { waba_id: "waba1" } });
    expect(calls[1]?.query).toMatchObject({ limit: 100 });
    expect(signals.map((s) => s.external_id)).toEqual(["phone:p1:GREEN:APPROVED", "template:t1:APPROVED"]);
    expect(signals.every((s) => s.at === since.toISOString())).toBe(true);
    expect(signals[1]?.title).toBe("Template order_update (es) · APPROVED");
    expect(signals[1]?.text).toContain("body: Tu pedido va en camino");
    expect(signals[1]?.text).toContain("button (url): Seguir → https://acme.test/track");
    // No `paging.next` → no second templates page.
    expect(calls.filter((c) => c.path.endsWith("/message_templates"))).toHaveLength(1);
    expect(stats).toMatchObject({ template_pages: 1, signals: 2 });
    expect(templateText([{ type: "HEADER", format: "IMAGE" }])).toBe("header: <image>");
  });
});

describe("linkedin adapter", () => {
  it("returns nothing without an organization id", async () => {
    const { client, calls } = fakeClient(() => ({}));
    const out = await linkedinAdapter.fetchChanges({ client, ...base });
    expect(out.signals).toEqual([]);
    expect(out.stats).toEqual({ missing_organization_id: 1 });
    expect(calls).toHaveLength(0);
  });

  it("lists organisation posts modified since with versioned headers and attaches comments", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/rest/posts") {
        return {
          elements: [
            { id: "urn:li:share:100", commentary: "We shipped v2.\nMore inside.", createdAt: Date.parse("2026-09-02T08:00:00Z"), lastModifiedAt: Date.parse("2026-09-02T09:00:00Z"), lifecycleState: "PUBLISHED", visibility: "PUBLIC" },
            { id: "urn:li:share:99", commentary: "Old", lastModifiedAt: Date.parse("2026-08-01T00:00:00Z"), lifecycleState: "PUBLISHED" },
          ],
        };
      }
      if (req.path === `/rest/socialActions/${encodeURIComponent("urn:li:share:100")}/comments`) {
        return { elements: [{ message: { text: "Congrats!" }, actor: "urn:li:person:abc", created: { time: Date.parse("2026-09-02T10:00:00Z") } }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await linkedinAdapter.fetchChanges({ client, ...base, config: { organization_id: "12345" } });
    expect(calls[0]?.query).toMatchObject({ q: "author", author: "urn:li:organization:12345", sortBy: "LAST_MODIFIED", count: 50 });
    expect(calls[0]?.headers).toMatchObject(LINKEDIN_HEADERS);
    expect(signals.map((s) => s.external_id)).toEqual(["post:urn:li:share:100"]);
    expect(signals[0]).toMatchObject({ title: "We shipped v2.", url: postUrl("urn:li:share:100"), author: "urn:li:organization:12345", at: "2026-09-02T09:00:00.000Z", kind_hint: "post" });
    expect(signals[0]?.text).toContain("State: PUBLISHED · Visibility: PUBLIC");
    expect(signals[0]?.text).toContain("urn:li:person:abc (2026-09-02T10:00:00.000Z): Congrats!");
    expect(stats).toMatchObject({ posts: 1, detailed: 1 });
  });
});
