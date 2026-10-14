/**
 * Batch 2b adapters — request shape + mapping against a fake proxy client.
 * monday.com, Salesforce, Intercom, Discord, Fireflies.
 */
import { describe, expect, it } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { discordAdapter, snowflakeAfter } from "./discord";
import { firefliesAdapter } from "./fireflies";
import { INTERCOM_VERSION, intercomAdapter } from "./intercom";
import { MONDAY_API_VERSION, mondayAdapter, mondayQuery } from "./monday";
import { SALESFORCE_API, salesforceAdapter } from "./salesforce";

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

describe("monday adapter", () => {
  it("queries items updated after the cursor on the allow-listed boards and flattens columns + updates", async () => {
    const { client, calls } = fakeClient(() => ({
      data: {
        boards: [
          {
            id: "b1",
            name: "Roadmap",
            url: "https://acme.monday.com/boards/b1",
            items_page: {
              items: [
                {
                  id: "i1",
                  name: "Ship pricing v2",
                  updated_at: "2026-09-02T10:00:00Z",
                  url: "https://acme.monday.com/boards/b1/pulses/i1",
                  creator: { name: "Ana" },
                  column_values: [{ text: "Done", column: { title: "Status" } }, { text: "", column: { title: "Empty" } }],
                  updates: [{ id: "u1", text_body: "We agreed to launch in October.", created_at: "2026-09-02T09:00:00Z", creator: { name: "Bo" } }],
                },
              ],
            },
          },
        ],
      },
    }));
    const { signals, stats } = await mondayAdapter.fetchChanges({ client, ...base, config: { boards: ["b1"] } });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/v2");
    expect(calls[0]?.headers?.["API-Version"]).toBe(MONDAY_API_VERSION);
    const q = String((calls[0]?.body as { query: string }).query);
    expect(q).toBe(mondayQuery(["b1"], since, 50));
    expect(q).toContain('boards(ids: ["b1"])');
    expect(q).toContain('column_id: "__last_updated__"');
    expect(q).toContain(since.toISOString());
    expect(signals[0]?.external_id).toBe("item:i1");
    expect(signals[0]?.title).toBe("Roadmap · Ship pricing v2");
    expect(signals[0]?.text).toContain("Status: Done");
    expect(signals[0]?.text).not.toContain("Empty:");
    expect(signals[0]?.text).toContain("Bo (2026-09-02T09:00:00Z): We agreed to launch in October.");
    expect(signals[0]?.url).toBe("https://acme.monday.com/boards/b1/pulses/i1");
    expect(signals[0]?.at).toBe("2026-09-02T10:00:00Z");
    expect(stats).toEqual({ boards: 1, items: 1 });
    expect(mondayQuery(null, since, 50)).toContain("boards(limit: 50, state: active");
  });

  it("surfaces GraphQL errors", async () => {
    const { client } = fakeClient(() => ({ errors: [{ message: "Not authorized" }] }));
    await expect(mondayAdapter.fetchChanges({ client, ...base })).rejects.toThrow(/Not authorized/);
  });
});

describe("salesforce adapter", () => {
  it("runs one SOQL per object against the instance and follows nextRecordsUrl", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === `${SALESFORCE_API}/query` && String(req.query?.q).includes("FROM Opportunity")) {
        return {
          done: false,
          nextRecordsUrl: `${SALESFORCE_API}/query/01gXX-2000`,
          records: [
            { Id: "006A", Name: "Acme renewal", StageName: "Negotiation", Amount: 12000, CloseDate: "2026-10-01", NextStep: "Send MSA", Description: "12-month term agreed.", LastModifiedDate: "2026-09-02T10:00:00.000+0000", Owner: { Name: "Ana" }, Account: { Name: "Acme" } },
          ],
        };
      }
      if (req.path === `${SALESFORCE_API}/query/01gXX-2000`) {
        return { done: true, records: [{ Id: "006B", Name: "Second", StageName: "Closed Won", LastModifiedDate: "2026-09-01T10:00:00.000+0000" }] };
      }
      return { done: true, records: [] };
    });
    const { signals, stats } = await salesforceAdapter.fetchChanges({
      client,
      ...base,
      connectionConfig: { instance_url: "https://acme.my.salesforce.com/" },
      config: { objects: ["Opportunity", "Task"] },
    });
    expect(String(calls[0]?.query?.q)).toContain("FROM Opportunity WHERE LastModifiedDate > 2026-09-01T00:00:00.000Z");
    expect(String(calls[0]?.query?.q)).toContain("ORDER BY LastModifiedDate DESC");
    expect(calls[1]?.path).toBe(`${SALESFORCE_API}/query/01gXX-2000`);
    expect(calls[1]?.query).toBeUndefined();
    expect(String(calls[2]?.query?.q)).toContain("FROM Task WHERE");
    expect(calls).toHaveLength(3);
    expect(signals.map((s) => s.external_id)).toEqual(["opportunity:006A", "opportunity:006B"]);
    expect(signals[0]?.title).toBe("Acme · Acme renewal");
    expect(signals[0]?.text).toContain("Stage: Negotiation · Amount: 12000 · Close: 2026-10-01");
    expect(signals[0]?.text).toContain("Next step: Send MSA");
    expect(signals[0]?.url).toBe("https://acme.my.salesforce.com/lightning/r/Opportunity/006A/view");
    expect(signals[0]?.author).toBe("Ana");
    expect(stats).toEqual({ Opportunity: 2, Task: 0 });
  });
});

describe("intercom adapter", () => {
  it("searches conversations updated after the cursor, expands parts, and adds recently updated articles", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/conversations/search") return { conversations: [{ id: "c9", updated_at: 1788400000 }] };
      if (req.path === "/conversations/c9") {
        return {
          id: "c9",
          title: null,
          state: "closed",
          updated_at: 1788400000,
          source: { subject: "Refund request", body: "<p>Can I get a refund?</p>", author: { name: "Cus Tomer" } },
          conversation_parts: { conversation_parts: [{ body: "<p>Yes, refunded.</p>", author: { name: "Ana", type: "admin" } }, { body: null }] },
          tags: { tags: [{ name: "billing" }] },
        };
      }
      if (req.path === "/articles") {
        return { data: [{ id: "a1", title: "Refund policy", body: "<p>30 days.</p>", url: "https://help.acme.com/a1", state: "published", updated_at: 1788500000 }, { id: "a0", title: "Old", updated_at: 1000 }] };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await intercomAdapter.fetchChanges({ client, ...base, config: { app_id: "app1" } });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers?.["Intercom-Version"]).toBe(INTERCOM_VERSION);
    expect(calls[0]?.body).toMatchObject({ query: { field: "updated_at", operator: ">", value: Math.floor(since.getTime() / 1000) } });
    expect(calls[1]?.path).toBe("/conversations/c9");
    expect(signals.map((s) => s.external_id)).toEqual(["conversation:c9", "article:a1"]);
    expect(signals[0]?.title).toBe("Refund request");
    expect(signals[0]?.text).toContain("State: closed · Tags: billing");
    expect(signals[0]?.text).toContain("Cus Tomer: Can I get a refund?");
    expect(signals[0]?.text).toContain("Ana: Yes, refunded.");
    expect(signals[0]?.url).toBe("https://app.intercom.com/a/apps/app1/inbox/conversation/c9");
    expect(signals[0]?.at).toBe(new Date(1788400000 * 1000).toISOString());
    expect(signals[1]?.text).toContain("30 days.");
    expect(stats).toEqual({ conversations: 1, articles: 1 });
  });
});

describe("discord adapter", () => {
  it("derives the snowflake from the cursor", () => {
    expect(snowflakeAfter(new Date(1420070400000))).toBe("0");
    expect(snowflakeAfter(new Date(1420070400001))).toBe(String(1n << 22n));
  });

  it("reads messages after the cursor per allow-listed channel and counts forbidden guilds", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/v10/users/@me/guilds") return [{ id: "g1", name: "Acme" }, { id: "g2", name: "Other" }];
      if (req.path === "/api/v10/guilds/g1/channels") return [{ id: "ch1", name: "decisions", type: 0 }, { id: "ch2", name: "random", type: 0 }, { id: "v1", name: "voice", type: 2 }];
      if (req.path === "/api/v10/guilds/g2/channels") return { status: 403, data: {} };
      if (req.path === "/api/v10/channels/ch1/messages") {
        return [
          { id: "m2", content: "Agreed: ship Friday", timestamp: "2026-09-02T10:01:00Z", author: { username: "bo" } },
          { id: "m1", content: "Ship Friday?", timestamp: "2026-09-02T10:00:00Z", author: { username: "ana", global_name: "Ana" } },
          { id: "m3", content: "beep", timestamp: "2026-09-02T10:02:00Z", author: { username: "bot", bot: true } },
        ];
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await discordAdapter.fetchChanges({ client, ...base, config: { channels: ["decisions"] } });
    expect(calls.find((c) => c.path === "/api/v10/channels/ch1/messages")?.query).toEqual({ after: snowflakeAfter(since), limit: 100 });
    expect(calls.some((c) => c.path === "/api/v10/channels/ch2/messages")).toBe(false);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.external_id).toBe("channel:ch1:m2");
    expect(signals[0]?.title).toBe("Acme · #decisions");
    expect(signals[0]?.text).toBe("[2026-09-02T10:00:00Z] Ana: Ship Friday?\n[2026-09-02T10:01:00Z] bo: Agreed: ship Friday");
    expect(signals[0]?.url).toBe("https://discord.com/channels/g1/ch1/m2");
    expect(signals[0]?.at).toBe("2026-09-02T10:01:00Z");
    expect(stats).toEqual({ guilds: 2, channels: 1, messages: 2, forbidden: 1 });
  });
});

describe("fireflies adapter", () => {
  it("queries transcripts from the cursor and maps summary + sentences", async () => {
    const { client, calls } = fakeClient(() => ({
      data: {
        transcripts: [
          {
            id: "t1",
            title: "Pricing sync",
            date: 1788400000000,
            transcript_url: "https://app.fireflies.ai/view/t1",
            organizer_email: "ana@acme.com",
            summary: { overview: "Discussed tiers.", action_items: "Ana: draft pricing page", keywords: ["pricing", "tiers"] },
            sentences: [{ speaker_name: "Ana", text: "Let's go with three tiers." }, { speaker_name: "Bo", text: null }],
          },
        ],
      },
    }));
    const { signals } = await firefliesAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/graphql");
    expect(calls[0]?.body).toMatchObject({ variables: { fromDate: since.toISOString(), limit: 50 } });
    expect(signals[0]?.external_id).toBe("transcript:t1");
    expect(signals[0]?.title).toBe("Pricing sync");
    expect(signals[0]?.text).toContain("Overview:\nDiscussed tiers.");
    expect(signals[0]?.text).toContain("Action items:\nAna: draft pricing page");
    expect(signals[0]?.text).toContain("Keywords: pricing, tiers");
    expect(signals[0]?.text).toContain("Ana: Let's go with three tiers.");
    expect(signals[0]?.text).not.toContain("Bo:");
    expect(signals[0]?.url).toBe("https://app.fireflies.ai/view/t1");
    expect(signals[0]?.author).toBe("ana@acme.com");
    expect(signals[0]?.at).toBe(new Date(1788400000000).toISOString());
  });
});
