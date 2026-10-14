/**
 * Group: /api/connectors, /api/webhooks, /api/integrations.
 *
 * The group where the wire format is least uniform: OAuth callbacks answer
 * with a 307 and a `location`, Slack's handshake answers `text/plain`, the
 * receivers read the raw body for HMAC. Without Supabase most authorised paths
 * end in the same 500 both ways — that is still parity, and the error paths
 * before the database (validation, signature, secret) are exercised fully.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiApp } from "../app";
import type { RouteModule } from "../adapter";
import { assertParity, buildRequest, type ParityRequest } from "./harness";
import * as connectors from "@/app/api/connectors/route";
import * as githubCallback from "@/app/api/connectors/github/callback/route";
import * as linearCallback from "@/app/api/connectors/linear/callback/route";
import * as notionCallback from "@/app/api/connectors/notion/callback/route";
import * as slackCallback from "@/app/api/connectors/slack/callback/route";
import * as meetingBotSchedule from "@/app/api/connectors/meeting-bot/schedule/route";
import * as meetingBotWebhook from "@/app/api/connectors/meeting-bot/webhook/route";
import * as connectorConfigRoute from "@/app/api/connectors/[id]/config/route";
import * as connectorInstallRoute from "@/app/api/connectors/[id]/install/route";
import * as connectorSyncRoute from "@/app/api/connectors/[id]/sync/route";
import * as connectorUninstallRoute from "@/app/api/connectors/[id]/uninstall/route";
import * as meetingRecordsConfig from "@/app/api/integrations/meeting-records/config/route";
import * as meetingRecordsProposal from "@/app/api/integrations/meeting-records/proposal/route";
import * as deliveries from "@/app/api/webhooks/deliveries/route";
import * as deliveryRetryRoute from "@/app/api/webhooks/deliveries/[id]/retry/route";
import * as endpoints from "@/app/api/webhooks/endpoints/route";
import * as endpointRoute from "@/app/api/webhooks/endpoints/[id]/route";
import * as githubWebhook from "@/app/api/webhooks/github/route";
import * as linearWebhook from "@/app/api/webhooks/linear/route";
import * as slackWebhook from "@/app/api/webhooks/slack/route";

/**
 * The `:id` modules type `ctx.params` as `Promise<{ id: string }>`, narrower
 * than the `Record<string, string>` a router can promise. The route table
 * makes the same cast; here it is made once per module instead of per call.
 */
const asModule = (m: unknown): RouteModule => m as RouteModule;
const connectorConfig = asModule(connectorConfigRoute);
const connectorInstall = asModule(connectorInstallRoute);
const connectorSync = asModule(connectorSyncRoute);
const connectorUninstall = asModule(connectorUninstallRoute);
const deliveryRetry = asModule(deliveryRetryRoute);
const endpoint = asModule(endpointRoute);

const app = createApiApp({
  serve: ["/api/connectors", "/api/webhooks", "/api/integrations"],
});

/** Seeded demo workspace (`bcontext`) — the slug and the fixed id it carries. */
const DEMO_WS = "bcontext";
const DEMO_WS_ID = "00000000-0000-0000-0000-000000000010";
const UNKNOWN_UUID = "11111111-2222-4333-8444-555555555555";
/** A registered connector id and one that is not; the registry decides 404. */
const CONNECTOR = "github";
const NOT_A_CONNECTOR = "nope";

/**
 * `snapshot()` reads status, content-type and body; a redirect carries its
 * answer in `location`, which it never looks at. Compare that header directly,
 * and that `withRoute` still stamped the response — a Response built by hand
 * (see `redirectTo`) is exactly the kind that could lose its headers on the
 * way through a different server.
 */
async function assertRedirectParity(module: RouteModule, r: ParityRequest): Promise<void> {
  const handler = module[r.method];
  if (!handler) throw new Error(`route module has no ${r.method}`);
  const direct = await handler(buildRequest(r), { params: Promise.resolve(r.params ?? {}) });
  const viaHono = await app.request(buildRequest(r));
  expect(direct.status, `${r.path} should redirect`).toBe(307);
  expect(viaHono.status, `status differs (direct ${direct.status}, hono ${viaHono.status})`).toBe(direct.status);
  expect(viaHono.headers.get("location")).toBe(direct.headers.get("location"));
  expect(viaHono.headers.has("x-request-id")).toBe(direct.headers.has("x-request-id"));
  expect(await viaHono.text()).toBe(await direct.text());
}

/**
 * Parity, then the status the test names. Two calls that both hit a 429 or a
 * 500 agree perfectly and would otherwise pass as the path they claim to
 * exercise; pinned only where the answer is decided before the database.
 */
async function parityAt(status: number, module: RouteModule, r: ParityRequest): Promise<void> {
  const direct = await assertParity(app, module, r);
  expect(direct.status, `${r.method} ${r.path}`).toBe(status);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("parity: connectors", () => {
  it("GET /api/connectors (no workspace)", () => parityAt(400, connectors, { method: "GET", path: "/api/connectors" }));
  it("GET /api/connectors (demo workspace)", () =>
    parityAt(200, connectors, { method: "GET", path: `/api/connectors?workspace=${DEMO_WS}` }));
  it("GET /api/connectors (unknown workspace)", () =>
    parityAt(404, connectors, { method: "GET", path: "/api/connectors?workspace=does-not-exist" }));

  // Callbacks: the redirect is the response. Missing params redirect before any
  // lookup; a state that looks real reaches the install lookup, which without a
  // database becomes the generic 500 — both are the redirect/5xx the browser
  // would see, and both must be the same either way.
  it("GET /api/connectors/github/callback (missing params → redirect)", () =>
    assertRedirectParity(githubCallback, { method: "GET", path: "/api/connectors/github/callback" }));
  it("GET /api/connectors/github/callback (well-formed → lookup)", () =>
    assertParity(app, githubCallback, {
      method: "GET",
      path: `/api/connectors/github/callback?installation_id=12345&setup_action=install&state=${UNKNOWN_UUID}`,
    }));
  it("GET /api/connectors/linear/callback (missing params → redirect)", () =>
    assertRedirectParity(linearCallback, { method: "GET", path: "/api/connectors/linear/callback?code=abc" }));
  it("GET /api/connectors/linear/callback (well-formed → lookup)", () =>
    assertParity(app, linearCallback, {
      method: "GET",
      path: `/api/connectors/linear/callback?code=abc&state=${UNKNOWN_UUID}`,
    }));
  it("GET /api/connectors/notion/callback (missing params → redirect)", () =>
    assertRedirectParity(notionCallback, { method: "GET", path: `/api/connectors/notion/callback?state=${UNKNOWN_UUID}` }));
  it("GET /api/connectors/notion/callback (well-formed → lookup)", () =>
    assertParity(app, notionCallback, {
      method: "GET",
      path: `/api/connectors/notion/callback?code=abc&state=${UNKNOWN_UUID}`,
    }));
  it("GET /api/connectors/slack/callback (missing params → redirect)", () =>
    assertRedirectParity(slackCallback, { method: "GET", path: "/api/connectors/slack/callback" }));
  it("GET /api/connectors/slack/callback (well-formed → lookup)", () =>
    assertParity(app, slackCallback, {
      method: "GET",
      path: `/api/connectors/slack/callback?code=abc&state=${UNKNOWN_UUID}`,
    }));

  it("POST /api/connectors/meeting-bot/schedule (invalid body)", () =>
    parityAt(400, meetingBotSchedule, { method: "POST", path: "/api/connectors/meeting-bot/schedule", body: {} }));
  it("POST /api/connectors/meeting-bot/schedule (unknown workspace)", () =>
    parityAt(404, meetingBotSchedule, {
      method: "POST",
      path: "/api/connectors/meeting-bot/schedule",
      body: { workspace: "does-not-exist", meetingUrl: "https://meet.example.com/abc", consent: true },
    }));
  it("POST /api/connectors/meeting-bot/schedule (demo workspace)", () =>
    parityAt(503, meetingBotSchedule, {
      method: "POST",
      path: "/api/connectors/meeting-bot/schedule",
      body: { workspace: DEMO_WS, meetingUrl: "https://meet.example.com/abc", consent: true },
    }));

  // Unsigned, and signed with headers the provider recognises but cannot
  // verify — the second is the shape a real misconfiguration produces.
  it("POST /api/connectors/meeting-bot/webhook (unsigned)", () =>
    parityAt(400, meetingBotWebhook, {
      method: "POST",
      path: "/api/connectors/meeting-bot/webhook",
      body: { type: "bot.done", data: { bot_id: "b1" } },
    }));
  it("POST /api/connectors/meeting-bot/webhook (unverifiable signature)", () =>
    parityAt(400, meetingBotWebhook, {
      method: "POST",
      path: "/api/connectors/meeting-bot/webhook",
      headers: { "svix-id": "msg_1", "svix-timestamp": "1700000000", "svix-signature": "v1,AAAA" },
      body: { type: "bot.done", data: { bot_id: "b1" } },
    }));

  it("PATCH /api/connectors/:id/config (invalid body)", () =>
    parityAt(400, connectorConfig, {
      method: "PATCH",
      path: `/api/connectors/${CONNECTOR}/config`,
      params: { id: CONNECTOR },
      body: {},
    }));
  it("PATCH /api/connectors/:id/config (unknown workspace)", () =>
    parityAt(404, connectorConfig, {
      method: "PATCH",
      path: `/api/connectors/${CONNECTOR}/config`,
      params: { id: CONNECTOR },
      body: { workspace_id: UNKNOWN_UUID, ingest_guidance: "x" },
    }));
  it("PATCH /api/connectors/:id/config (demo workspace)", () =>
    assertParity(app, connectorConfig, {
      method: "PATCH",
      path: `/api/connectors/${CONNECTOR}/config`,
      params: { id: CONNECTOR },
      body: { workspace_id: DEMO_WS_ID, ingest_guidance: "x" },
    }));
  it("PATCH /api/connectors/:id/config (unknown connector)", () =>
    assertParity(app, connectorConfig, {
      method: "PATCH",
      path: `/api/connectors/${NOT_A_CONNECTOR}/config`,
      params: { id: NOT_A_CONNECTOR },
      body: { workspace_id: DEMO_WS_ID, ingest_guidance: "x" },
    }));

  // install / sync / uninstall demand a user session before reading the id,
  // so the demo actor sees the same 403 for any id. Both ids are still sent:
  // parity on the param is what the group promotes.
  for (const id of [CONNECTOR, NOT_A_CONNECTOR]) {
    it(`POST /api/connectors/:id/install (${id})`, () =>
      parityAt(403, connectorInstall, {
        method: "POST",
        path: `/api/connectors/${id}/install`,
        params: { id },
        body: { workspace_id: DEMO_WS_ID },
      }));
    it(`POST /api/connectors/:id/sync (${id})`, () =>
      parityAt(403, connectorSync, {
        method: "POST",
        path: `/api/connectors/${id}/sync`,
        params: { id },
        body: { workspace_id: DEMO_WS_ID },
      }));
    it(`POST /api/connectors/:id/uninstall (${id})`, () =>
      parityAt(403, connectorUninstall, {
        method: "POST",
        path: `/api/connectors/${id}/uninstall`,
        params: { id },
        body: { workspace_id: DEMO_WS_ID },
      }));
  }
});

describe("parity: integrations", () => {
  const CONFIG = {
    workspace: DEMO_WS,
    objective: "Capture decisions and action items from every weekly sync",
    extraction_items: [{ id: "decisions-0", label: "Decisions", detail: "Explicit decisions made." }],
  };

  it("GET /api/integrations/meeting-records/config (no workspace)", () =>
    parityAt(400, meetingRecordsConfig, { method: "GET", path: "/api/integrations/meeting-records/config" }));
  it("GET /api/integrations/meeting-records/config (demo workspace)", () =>
    parityAt(200, meetingRecordsConfig, {
      method: "GET",
      path: `/api/integrations/meeting-records/config?workspace=${DEMO_WS}`,
    }));
  it("PUT /api/integrations/meeting-records/config (invalid body)", () =>
    parityAt(400, meetingRecordsConfig, { method: "PUT", path: "/api/integrations/meeting-records/config", body: {} }));
  it("PUT /api/integrations/meeting-records/config (unknown workspace)", () =>
    parityAt(404, meetingRecordsConfig, {
      method: "PUT",
      path: "/api/integrations/meeting-records/config",
      body: { ...CONFIG, workspace: "does-not-exist" },
    }));
  it("PUT /api/integrations/meeting-records/config (demo workspace)", () => {
    // `configured_at` is stamped from the clock and is not in VOLATILE; two
    // writes a millisecond apart would differ for a reason that is not routing.
    // Freeze at the real now — a clock set into the past would starve the
    // rate limiter's refill and turn both calls into a 429.
    vi.useFakeTimers({ toFake: ["Date"] });
    return parityAt(200, meetingRecordsConfig, {
      method: "PUT",
      path: "/api/integrations/meeting-records/config",
      body: CONFIG,
    });
  });

  it("POST /api/integrations/meeting-records/proposal (invalid body)", () =>
    parityAt(400, meetingRecordsProposal, { method: "POST", path: "/api/integrations/meeting-records/proposal", body: {} }));
  it("POST /api/integrations/meeting-records/proposal (unknown workspace)", () =>
    parityAt(404, meetingRecordsProposal, {
      method: "POST",
      path: "/api/integrations/meeting-records/proposal",
      body: { workspace: "does-not-exist", objective: CONFIG.objective },
    }));
  // No gateway key in tests → the deterministic heuristic, so the body is a
  // real proposal and not just an error envelope.
  it("POST /api/integrations/meeting-records/proposal (demo workspace)", () =>
    parityAt(200, meetingRecordsProposal, {
      method: "POST",
      path: "/api/integrations/meeting-records/proposal",
      body: { workspace: DEMO_WS, objective: "Track bugs, deadlines and customer feedback from calls" },
    }));
});

describe("parity: webhook management", () => {
  it("GET /api/webhooks/deliveries (no workspace)", () =>
    parityAt(400, deliveries, { method: "GET", path: "/api/webhooks/deliveries" }));
  it("GET /api/webhooks/deliveries (demo workspace)", () =>
    parityAt(200, deliveries, { method: "GET", path: `/api/webhooks/deliveries?workspace=${DEMO_WS}&status=dead` }));

  it("POST /api/webhooks/deliveries/:id/retry", () =>
    parityAt(403, deliveryRetry, {
      method: "POST",
      path: `/api/webhooks/deliveries/${UNKNOWN_UUID}/retry`,
      params: { id: UNKNOWN_UUID },
    }));

  it("GET /api/webhooks/endpoints (no workspace_id)", () =>
    parityAt(400, endpoints, { method: "GET", path: "/api/webhooks/endpoints" }));
  it("GET /api/webhooks/endpoints (workspace_id)", () =>
    assertParity(app, endpoints, { method: "GET", path: `/api/webhooks/endpoints?workspace_id=${DEMO_WS_ID}` }));
  it("POST /api/webhooks/endpoints (not JSON)", () =>
    parityAt(400, endpoints, { method: "POST", path: "/api/webhooks/endpoints", body: "not json" }));
  it("POST /api/webhooks/endpoints (invalid body)", () =>
    parityAt(400, endpoints, { method: "POST", path: "/api/webhooks/endpoints", body: { url: "nope" } }));
  it("POST /api/webhooks/endpoints (valid body)", () =>
    assertParity(app, endpoints, {
      method: "POST",
      path: "/api/webhooks/endpoints",
      body: { workspace_id: DEMO_WS_ID, url: "https://hooks.example.com/in", event_types: ["node.created"] },
    }));

  // The id is validated as a uuid before anything else, so the non-uuid case
  // proves the param itself arrived through Hono unchanged.
  it("DELETE /api/webhooks/endpoints/:id (not a uuid)", () =>
    parityAt(400, endpoint, { method: "DELETE", path: "/api/webhooks/endpoints/not-a-uuid", params: { id: "not-a-uuid" } }));
  it("PATCH /api/webhooks/endpoints/:id (not a uuid)", () =>
    parityAt(400, endpoint, {
      method: "PATCH",
      path: "/api/webhooks/endpoints/not-a-uuid",
      params: { id: "not-a-uuid" },
      body: { paused: true },
    }));
  it("POST /api/webhooks/endpoints/:id (not a uuid)", () =>
    parityAt(400, endpoint, { method: "POST", path: "/api/webhooks/endpoints/not-a-uuid", params: { id: "not-a-uuid" } }));
  it("DELETE /api/webhooks/endpoints/:id (uuid)", () =>
    assertParity(app, endpoint, { method: "DELETE", path: `/api/webhooks/endpoints/${UNKNOWN_UUID}`, params: { id: UNKNOWN_UUID } }));
  it("PATCH /api/webhooks/endpoints/:id (uuid)", () =>
    assertParity(app, endpoint, {
      method: "PATCH",
      path: `/api/webhooks/endpoints/${UNKNOWN_UUID}`,
      params: { id: UNKNOWN_UUID },
      body: { paused: true },
    }));
  it("POST /api/webhooks/endpoints/:id (uuid)", () =>
    assertParity(app, endpoint, { method: "POST", path: `/api/webhooks/endpoints/${UNKNOWN_UUID}`, params: { id: UNKNOWN_UUID } }));
  it("PATCH /api/webhooks/endpoints/:id (invalid body)", () =>
    parityAt(400, endpoint, {
      method: "PATCH",
      path: `/api/webhooks/endpoints/${UNKNOWN_UUID}`,
      params: { id: UNKNOWN_UUID },
      body: { paused: "yes" },
    }));
});

describe("parity: webhook receivers", () => {
  // Receivers authenticate the body, not the caller: invalid JSON and a
  // payload with no install reference are rejected before any lookup; a
  // well-formed one reaches the install lookup, which without a database is
  // the same 500 both ways. Signature headers are carried so the raw-body
  // path Hono hands over is the one verified.
  it("POST /api/webhooks/github (invalid JSON)", () =>
    parityAt(400, githubWebhook, { method: "POST", path: "/api/webhooks/github", body: "{" }));
  it("POST /api/webhooks/github (no installation)", () =>
    parityAt(400, githubWebhook, { method: "POST", path: "/api/webhooks/github", body: { action: "opened" } }));
  it("POST /api/webhooks/github (well-formed, unverifiable)", () =>
    assertParity(app, githubWebhook, {
      method: "POST",
      path: "/api/webhooks/github",
      headers: { "x-github-event": "issues", "x-hub-signature-256": "sha256=deadbeef" },
      body: { action: "opened", installation: { id: 12345 } },
    }));

  it("POST /api/webhooks/linear (invalid JSON)", () =>
    parityAt(400, linearWebhook, { method: "POST", path: "/api/webhooks/linear", body: "{" }));
  it("POST /api/webhooks/linear (no webhookId)", () =>
    parityAt(400, linearWebhook, { method: "POST", path: "/api/webhooks/linear", body: { action: "create" } }));
  it("POST /api/webhooks/linear (well-formed, unverifiable)", () =>
    assertParity(app, linearWebhook, {
      method: "POST",
      path: "/api/webhooks/linear",
      headers: { "linear-signature": "deadbeef" },
      body: { action: "create", webhookId: "wh_1", type: "Issue" },
    }));

  // Slack is the one receiver with a non-JSON success (`text/plain` challenge)
  // and a form-encoded branch; both are wire shapes Hono must pass untouched.
  it("POST /api/webhooks/slack (url_verification)", () =>
    parityAt(200, slackWebhook, {
      method: "POST",
      path: "/api/webhooks/slack",
      body: { type: "url_verification", challenge: "parity-challenge" },
    }));
  it("POST /api/webhooks/slack (invalid JSON)", () =>
    parityAt(400, slackWebhook, { method: "POST", path: "/api/webhooks/slack", body: "{" }));
  it("POST /api/webhooks/slack (event, no team)", () =>
    parityAt(200, slackWebhook, { method: "POST", path: "/api/webhooks/slack", body: { type: "event_callback" } }));
  it("POST /api/webhooks/slack (event, unverifiable)", () =>
    assertParity(app, slackWebhook, {
      method: "POST",
      path: "/api/webhooks/slack",
      headers: { "x-slack-signature": "v0=deadbeef", "x-slack-request-timestamp": "1700000000" },
      body: { type: "event_callback", team_id: "T123" },
    }));
  it("POST /api/webhooks/slack (slash command)", () =>
    assertParity(app, slackWebhook, {
      method: "POST",
      path: "/api/webhooks/slack",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "team_id=T123&command=%2Fbcontext&text=search+parity",
    }));
});
