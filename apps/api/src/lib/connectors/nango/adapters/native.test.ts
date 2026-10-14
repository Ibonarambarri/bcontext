/**
 * Nango-backed twins of the native connectors — request shape + mapping
 * against a fake proxy client. Slack, GitHub, Linear, Notion, Meeting records.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NangoClient, ProxyRequest, ProxyResponse } from "@/lib/nango/client";
import { githubNangoAdapter } from "./github-nango";
import { githubPatAdapter } from "./github-pat";
import { LINEAR_QUERY, linearNangoAdapter } from "./linear-nango";
import { meetingRecordsNangoAdapter, turnsFromDownload, turnsFromLegacy } from "./meeting-records-nango";
import { blocksToText, notionNangoAdapter, pageTitle } from "./notion-nango";
import { slackNangoAdapter, slackPermalink, slackText, slackTsToIso } from "./slack-nango";

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

describe("slack (via Nango) adapter", () => {
  it("lists channels, reads history after the cursor, folds threads and groups loose messages per day", async () => {
    const { client, calls } = fakeClient((req) => {
      switch (req.path) {
        case "/auth.test":
          return { ok: true, url: "https://acme.slack.com/" };
        case "/users.list":
          return { ok: true, members: [{ id: "U1", name: "bo", profile: { display_name: "Bo" } }, { id: "U2", real_name: "Ana Ruiz" }] };
        case "/conversations.list":
          return { ok: true, channels: [{ id: "C1", name: "product" }, { id: "C2", name: "random" }] };
        case "/conversations.history":
          return {
            ok: true,
            messages: [
              { ts: "1788336000.000100", user: "U1", text: "We ship <@U2>'s proposal on Friday", reply_count: 1, thread_ts: "1788336000.000100" },
              { ts: "1788339600.000200", user: "U2", text: "Standup notes: <https://x.y|doc>" },
              { ts: "1788339700.000300", bot_id: "B1", text: "bot noise" },
              { ts: "1788339800.000400", user: "U1", subtype: "channel_join", text: "joined" },
            ],
          };
        case "/conversations.replies":
          return { ok: true, messages: [{ ts: "1788336000.000100", user: "U1", text: "parent" }, { ts: "1788337000.000500", user: "U2", text: "Agreed, Friday it is" }] };
        default:
          return { status: 500, data: {} };
      }
    });
    const { signals, stats } = await slackNangoAdapter.fetchChanges({ client, ...base, config: { channels: ["product"] } });
    const history = calls.filter((c) => c.path === "/conversations.history");
    expect(history).toHaveLength(1);
    expect(history[0]?.providerConfigKey).toBe("slack-nango");
    expect(history[0]?.query?.channel).toBe("C1");
    expect(history[0]?.query?.oldest).toBe(String(Math.floor(since.getTime() / 1000)));
    expect(calls.find((c) => c.path === "/conversations.replies")?.query?.ts).toBe("1788336000.000100");
    expect(signals.map((s) => s.external_id)).toEqual(["thread:C1:1788336000.000100", "channel:C1:2026-09-02"]);
    expect(signals[0]?.text).toContain("Bo: We ship @Ana Ruiz's proposal on Friday");
    expect(signals[0]?.text).toContain("Ana Ruiz: Agreed, Friday it is");
    expect(signals[0]?.url).toBe("https://acme.slack.com/archives/C1/p1788336000000100");
    expect(signals[0]?.at).toBe(slackTsToIso("1788337000.000500"));
    expect(signals[1]?.text).toContain("Ana Ruiz: Standup notes: doc");
    expect(signals[1]?.text).not.toContain("bot noise");
    expect(signals[1]?.text).not.toContain("joined");
    expect(stats?.channels).toBe(1);
    expect(stats?.threads).toBe(1);
  });

  it("helpers: ts → ISO, permalink, mention rendering", () => {
    expect(slackTsToIso("1788336000.000100")).toBe("2026-09-02T08:00:00.000Z");
    expect(slackPermalink("https://acme.slack.com", "C1", "1.2")).toBe("https://acme.slack.com/archives/C1/p12");
    expect(slackPermalink("", "C1", "1.2")).toBeUndefined();
    expect(slackText("hi <@U1> see <#C9|general> and <http://a.b|link> &amp; <http://c.d>", new Map([["U1", "Bo"]]))).toBe("hi @Bo see #general and link & http://c.d");
  });
});

describe("github (via Nango) adapter", () => {
  it("shares the PAT implementation but addresses the github-nango integration", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/repos/acme/app/issues") {
        return [{ id: 7, number: 42, title: "Retry uploads", body: "Flaky", state: "open", html_url: "https://github.com/acme/app/issues/42", updated_at: "2026-09-03T10:00:00Z", user: { login: "bo" }, repository_url: "https://api.github.com/repos/acme/app", comments: 0 }];
      }
      return [];
    });
    const { signals } = await githubNangoAdapter.fetchChanges({ client, ...base, config: { repos: ["acme/app"] } });
    expect(githubNangoAdapter.id).toBe("github-nango");
    expect(githubNangoAdapter.provider).toBe("github");
    expect(githubPatAdapter.id).toBe("github-pat");
    expect(calls[0]?.providerConfigKey).toBe("github-nango");
    expect(calls[0]?.query?.since).toBe(since.toISOString());
    expect(signals.map((s) => s.external_id)).toEqual(["issue:7"]);
    expect(signals[0]?.title).toBe("acme/app#42 · Retry uploads");
  });
});

describe("linear (via Nango) adapter", () => {
  it("posts the GraphQL query with the cursor, pages issues and maps project updates once", async () => {
    let page = 0;
    const { client, calls } = fakeClient((req) => {
      page += 1;
      const vars = (req.body as { variables: { after: string | null; withUpdates: boolean } }).variables;
      return {
        data: {
          issues: {
            nodes: [
              {
                id: vars.after ? "i2" : "i1",
                identifier: vars.after ? "ENG-2" : "ENG-1",
                title: vars.after ? "Second" : "Ship search",
                description: "Details",
                url: "https://linear.app/acme/issue/ENG-1",
                updatedAt: "2026-09-03T10:00:00Z",
                priorityLabel: "High",
                state: { name: "In Progress", type: "started" },
                team: { key: "ENG", name: "Engineering" },
                project: { name: "Search" },
                assignee: { name: "Ana" },
                creator: { name: "Bo" },
                labels: { nodes: [{ name: "backend" }] },
                comments: { nodes: [{ body: "Blocked on infra", createdAt: "2026-09-03T09:00:00Z", user: { name: "Ana" } }] },
              },
              { id: "x1", identifier: "OPS-1", title: "Other team", team: { key: "OPS", name: "Ops" }, updatedAt: "2026-09-03T10:00:00Z" },
            ],
            pageInfo: { hasNextPage: !vars.after, endCursor: vars.after ? null : "cur2" },
          },
          ...(vars.withUpdates
            ? { projectUpdates: { nodes: [{ id: "pu1", body: "On track for Q4", health: "onTrack", updatedAt: "2026-09-02T10:00:00Z", user: { name: "Bo" }, project: { name: "Search", url: "https://linear.app/acme/project/search" } }] } }
            : {}),
        },
      };
    });
    const { signals, stats } = await linearNangoAdapter.fetchChanges({ client, ...base, config: { teams: ["eng"] } });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/graphql");
    expect(calls[0]?.providerConfigKey).toBe("linear-nango");
    expect((calls[0]?.body as { query: string }).query).toBe(LINEAR_QUERY);
    expect((calls[0]?.body as { variables: { since: string; withUpdates: boolean } }).variables).toMatchObject({ since: since.toISOString(), withUpdates: true });
    expect((calls[1]?.body as { variables: { after: string; withUpdates: boolean } }).variables).toMatchObject({ after: "cur2", withUpdates: false });
    expect(page).toBe(2);
    expect(signals.map((s) => s.external_id)).toEqual(["project-update:pu1", "issue:i1", "issue:i2"]);
    expect(signals[1]?.title).toBe("ENG-1 · Ship search");
    expect(signals[1]?.text).toContain("Team: Engineering · State: In Progress (started) · Priority: High");
    expect(signals[1]?.text).toContain("- Ana (2026-09-03T09:00:00Z): Blocked on infra");
    expect(signals[0]?.title).toBe("Search · project update (onTrack)");
    expect(stats?.issues).toBe(2);
    expect(stats?.project_updates).toBe(1);
  });
});

describe("notion (via Nango) adapter", () => {
  it("searches newest-first, stops at the cursor and flattens the page body", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/search") {
        return {
          results: [
            { id: "p1", object: "page", url: "https://notion.so/p1", last_edited_time: "2026-09-03T10:00:00Z", properties: { Name: { type: "title", title: [{ plain_text: "Q4 " }, { plain_text: "plan" }] } } },
            { id: "p0", object: "page", last_edited_time: "2026-08-20T10:00:00Z", properties: {} },
          ],
          has_more: true,
          next_cursor: "n2",
        };
      }
      if (req.path === "/v1/blocks/p1/children") {
        return {
          results: [
            { id: "b1", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Goals" }] } },
            { id: "b2", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Grow " }, { plain_text: "revenue" }] } },
            { id: "b3", type: "to_do", to_do: { rich_text: [{ plain_text: "Hire PM" }], checked: true } },
            { id: "b4", type: "image", image: {} },
          ],
          has_more: false,
        };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await notionNangoAdapter.fetchChanges({ client, ...base });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers?.["Notion-Version"]).toBe("2022-06-28");
    expect(calls.filter((c) => c.path === "/v1/search")).toHaveLength(1); // stopped at the older page
    expect(calls[1]?.path).toBe("/v1/blocks/p1/children");
    expect(signals.map((s) => s.external_id)).toEqual(["page:p1"]);
    expect(signals[0]?.title).toBe("Q4 plan");
    expect(signals[0]?.text).toBe("## Goals\nGrow revenue\n- [x] Hire PM");
    expect(signals[0]?.url).toBe("https://notion.so/p1");
    expect(stats?.pages).toBe(1);
  });

  it("queries the configured databases with a last_edited_time filter instead of search", async () => {
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/v1/databases/db1/query") {
        return { results: [{ id: "r1", object: "page", last_edited_time: "2026-09-03T10:00:00Z", properties: { T: { type: "title", title: [{ plain_text: "Row" }] } } }], has_more: false };
      }
      if (req.path.startsWith("/v1/blocks/")) return { results: [], has_more: false };
      return { status: 500, data: {} };
    });
    const { signals } = await notionNangoAdapter.fetchChanges({ client, ...base, config: { database_ids: ["db1"] } });
    expect(calls[0]?.path).toBe("/v1/databases/db1/query");
    expect((calls[0]?.body as { filter: { last_edited_time: { after: string } } }).filter.last_edited_time.after).toBe(since.toISOString());
    expect(signals.map((s) => s.external_id)).toEqual(["page:r1"]);
    expect(signals[0]?.text).toBe("Row");
  });

  it("helpers: title property and block flattening", () => {
    expect(pageTitle({ id: "x", properties: { A: { type: "rich_text" }, B: { type: "title", title: [{ plain_text: "Hi" }] } } })).toBe("Hi");
    expect(blocksToText([{ id: "1", type: "quote", quote: { rich_text: [{ plain_text: "q" }] } }, { id: "2", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "b" }] } }])).toBe("> q\n- b");
  });
});

describe("meeting records (via Nango) adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists finished bots after the cursor and reads the transcript from the pre-signed download", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { participant: { id: 1, name: "Bo" }, words: [{ text: "Let's", start_timestamp: { relative: 61 } }, { text: "ship" }] },
        { participant: { id: 2, name: null }, words: [{ text: "Agreed", start_timestamp: { relative: 65 } }] },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/v1/bot/") {
        return {
          results: [
            {
              id: "bot1",
              join_at: "2026-09-03T09:00:00Z",
              status_changes: [{ code: "joining_call", created_at: "2026-09-03T09:00:00Z" }, { code: "done", created_at: "2026-09-03T10:00:00Z" }],
              meeting_url: { platform: "google_meet", meeting_id: "abc" },
              meeting_metadata: { title: "Roadmap sync" },
              meeting_participants: [{ name: "Bo" }, { name: "Ana" }],
              recordings: [{ media_shortcuts: { transcript: { status: { code: "done" }, data: { download_url: "https://storage.recall.ai/x?sig=1" } } } }],
            },
            { id: "bot2", join_at: "2026-09-03T11:00:00Z", status_changes: [{ code: "in_call_recording", created_at: "2026-09-03T11:00:00Z" }] },
          ],
          next: null,
        };
      }
      return { status: 500, data: {} };
    });
    const { signals, stats } = await meetingRecordsNangoAdapter.fetchChanges({ client, ...base, connectionConfig: { region: "us-west-2" } });
    expect(calls[0]?.providerConfigKey).toBe("meeting-records-nango");
    expect(calls[0]?.query?.join_at_after).toBe(since.toISOString());
    expect(fetchMock).toHaveBeenCalledWith("https://storage.recall.ai/x?sig=1");
    expect(signals.map((s) => s.external_id)).toEqual(["bot:bot1"]);
    expect(signals[0]?.title).toBe("Roadmap sync");
    expect(signals[0]?.text).toContain("Participants: Bo, Ana");
    expect(signals[0]?.text).toContain("[01:01] Bo: Let's ship");
    expect(signals[0]?.text).toContain("[01:05] Speaker 2: Agreed");
    expect(signals[0]?.at).toBe("2026-09-03T10:00:00Z");
    expect(stats?.transcripts).toBe(1);
    expect(calls.some((c) => c.path.endsWith("/transcript/"))).toBe(false);
  });

  it("falls back to the legacy transcript endpoint through the proxy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const { client, calls } = fakeClient((req) => {
      if (req.path === "/api/v1/bot/") {
        return { results: [{ id: "b9", join_at: "2026-09-03T09:00:00Z", status_changes: [{ code: "done", created_at: "2026-09-03T10:00:00Z" }], meeting_url: "https://zoom.us/j/1" }], next: null };
      }
      if (req.path === "/api/v1/bot/b9/transcript/") {
        return { monologues: [{ speaker: { name: "Ana" }, words: [{ text: "Hello", start_timestamp: { relative: 3 } }] }] };
      }
      return { status: 500, data: {} };
    });
    const { signals } = await meetingRecordsNangoAdapter.fetchChanges({ client, ...base });
    expect(calls.map((c) => c.path)).toEqual(["/api/v1/bot/", "/api/v1/bot/b9/transcript/"]);
    expect(signals[0]?.text).toContain("[00:03] Ana: Hello");
    expect(signals[0]?.title).toBe("meeting 2026-09-03 09:00");
  });

  it("helpers: both transcript shapes", () => {
    expect(turnsFromDownload([{ participant: { name: "X" }, words: [{ text: "a" }, { text: "b" }] }])).toEqual(["[00:00] X: a b"]);
    expect(turnsFromLegacy({ data: [{ speaker: "Y", words: [{ text: "c", start_time: 70 }] }] })).toEqual(["[01:10] Y: c"]);
    expect(turnsFromLegacy({})).toEqual([]);
  });
});
