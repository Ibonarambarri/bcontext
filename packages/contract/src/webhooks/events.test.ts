import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  buildCloudEvent,
  hashSecret,
  isWebhookEventType,
  matchesEvent,
  parseEventTypes,
  serializeEvent,
  sign,
  WEBHOOK_EVENT_TYPES,
} from "./events.js";

describe("buildCloudEvent", () => {
  it("produces a CloudEvents v1.0 envelope with required fields", () => {
    const evt = buildCloudEvent({
      type: "node.created",
      workspaceSlug: "bcontext",
      data: { id: "n1", title: "hello" },
      id: "evt-123",
      time: new Date("2026-05-19T00:00:00.000Z"),
    });
    expect(evt.specversion).toBe("1.0");
    expect(evt.id).toBe("evt-123");
    expect(evt.type).toBe("node.created");
    expect(evt.source).toBe("bcontext/bcontext");
    expect(evt.time).toBe("2026-05-19T00:00:00.000Z");
    expect(evt.datacontenttype).toBe("application/json");
    expect(evt.data).toEqual({ id: "n1", title: "hello" });
  });

  it("auto-generates id and time when not provided", () => {
    const evt = buildCloudEvent({
      type: "node.updated",
      workspaceSlug: "demo",
      data: {},
    });
    expect(evt.id).toMatch(/^[0-9a-f]{8}-/);
    // ISO-8601: YYYY-MM-DDTHH:MM:SS.sssZ
    expect(evt.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("serializeEvent", () => {
  it("serializes deterministically when the input is the same", () => {
    const evt = buildCloudEvent({
      type: "node.created",
      workspaceSlug: "bcontext",
      data: { id: "n1" },
      id: "x",
      time: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(serializeEvent(evt)).toBe(serializeEvent(evt));
  });
});

describe("sign", () => {
  it("returns the Stripe-shaped header `t=<ts>,v1=<mac>`", () => {
    const out = sign("hello", "shh", 1700000000);
    expect(out.ts).toBe(1700000000);
    expect(out.header).toBe(`t=1700000000,v1=${out.v1}`);
  });

  it("is deterministic for the same (body, secret, ts)", () => {
    const a = sign("payload", "secret", 1);
    const b = sign("payload", "secret", 1);
    expect(a.v1).toBe(b.v1);
  });

  it("changes when any of body/secret/ts changes", () => {
    const base = sign("p", "s", 1);
    expect(sign("p2", "s", 1).v1).not.toBe(base.v1);
    expect(sign("p", "s2", 1).v1).not.toBe(base.v1);
    expect(sign("p", "s", 2).v1).not.toBe(base.v1);
  });

  it("matches an externally-computed HMAC for verifier compatibility", () => {
    const body = '{"a":1}';
    const secret = "topsecret";
    const ts = 1700000000;
    const expected = createHmac("sha256", secret)
      .update(`${ts}.${body}`)
      .digest("base64");
    const out = sign(body, secret, ts);
    expect(out.v1).toBe(expected);
  });
});

describe("hashSecret", () => {
  it("returns a 64-char hex string", async () => {
    const h = await hashSecret("whsec_test");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is deterministic", async () => {
    expect(await hashSecret("whsec_x")).toBe(await hashSecret("whsec_x"));
  });
});

describe("event-type catalog", () => {
  it("recognizes every published event type", () => {
    for (const t of WEBHOOK_EVENT_TYPES) {
      expect(isWebhookEventType(t)).toBe(true);
    }
  });
  it("rejects unknown types", () => {
    expect(isWebhookEventType("node.exploded")).toBe(false);
    expect(isWebhookEventType(42)).toBe(false);
  });
  it("parseEventTypes filters + dedupes", () => {
    const out = parseEventTypes([
      "node.created",
      "node.created",
      "bogus",
      "node.updated",
    ]);
    expect(out).toEqual(["node.created", "node.updated"]);
  });
});

describe("matchesEvent", () => {
  it("returns false for empty subscriptions", () => {
    expect(matchesEvent([], "node.created")).toBe(false);
  });
  it("supports a literal wildcard", () => {
    expect(matchesEvent(["*"], "node.deleted")).toBe(true);
  });
  it("matches exact event types", () => {
    expect(matchesEvent(["node.created"], "node.created")).toBe(true);
    expect(matchesEvent(["node.created"], "node.updated")).toBe(false);
  });
});
