import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockProposeSlackDecisionCandidate = vi.fn();
vi.mock("@/lib/ingest/extractors/slack", () => ({
  proposeSlackDecisionCandidate: (
    args: Parameters<typeof mockProposeSlackDecisionCandidate>[0],
  ) => mockProposeSlackDecisionCandidate(args),
}));

import { DECISION_REACTION, slackConnector } from "./index";
import type { ConnectorContext, WebhookEnvelope } from "@bcontext-dev/contract/connectors/types";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

async function signedEnvelope(body: string): Promise<WebhookEnvelope> {
  const ts = String(Math.floor(Date.now() / 1000));
  const base = `v0:${ts}:${body}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    rawBody: body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": `v0=${hex}`,
    },
  };
}

function reactionAddedBody(reaction: string): string {
  return JSON.stringify({
    type: "event_callback",
    event: {
      type: "reaction_added",
      user: "U_REACTOR",
      reaction,
      item: { type: "message", channel: "C1", ts: "100.200" },
    },
  });
}

function baseCtx(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    workspaceId: "ws-1",
    installId: "install-1",
    config: {},
    secret: "xoxb-bot-token",
    ...overrides,
  };
}

describe("slack connector — decision capture (NEXO-04)", () => {
  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  });

  afterEach(() => {
    mockProposeSlackDecisionCandidate.mockReset();
    vi.unstubAllGlobals();
    delete process.env.SLACK_SIGNING_SECRET;
  });

  it("fetches the thread and proposes a decision candidate on the decision marker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("conversations.replies")) {
          return {
            json: async () => ({
              ok: true,
              messages: [
                { user: "U1", text: "Should we ship Friday?", ts: "100.200" },
                { user: "U2", text: "Yes.", ts: "100.201" },
              ],
            }),
          };
        }
        if (url.includes("chat.getPermalink")) {
          return { json: async () => ({ ok: true, permalink: "https://x.slack.com/archives/C1/p100200" }) };
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const envelope = await signedEnvelope(reactionAddedBody(DECISION_REACTION));
    const outcome = await slackConnector.handleWebhook(baseCtx(), envelope);

    expect(outcome.audit).toBe("slack.reaction.decision_captured");
    expect(outcome.nodes).toEqual([]);
    expect(mockProposeSlackDecisionCandidate).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      channel: "C1",
      threadTs: "100.200",
      messages: [
        { user: "U1", text: "Should we ship Friday?", ts: "100.200" },
        { user: "U2", text: "Yes.", ts: "100.201" },
      ],
      permalink: "https://x.slack.com/archives/C1/p100200",
    });
  });

  it("never fires the decision pipeline for the plain :bcontext: pin reaction", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const envelope = await signedEnvelope(reactionAddedBody("bcontext"));
    const outcome = await slackConnector.handleWebhook(baseCtx(), envelope);

    expect(outcome.audit).toBe("slack.reaction.pinned");
    expect(mockProposeSlackDecisionCandidate).not.toHaveBeenCalled();
  });

  it("ignores unrelated reactions without touching Slack APIs", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const envelope = await signedEnvelope(reactionAddedBody("thumbsup"));
    const outcome = await slackConnector.handleWebhook(baseCtx(), envelope);

    expect(outcome.audit).toBe("slack.reaction.ignored");
    expect(mockProposeSlackDecisionCandidate).not.toHaveBeenCalled();
  });

  it("respects the channel allowlist for the decision marker", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const envelope = await signedEnvelope(reactionAddedBody(DECISION_REACTION));
    const outcome = await slackConnector.handleWebhook(
      baseCtx({ config: { channels: ["C_OTHER"] } }),
      envelope,
    );

    expect(outcome.audit).toBe("slack.reaction.not_allowlisted");
    expect(mockProposeSlackDecisionCandidate).not.toHaveBeenCalled();
  });

  it("skips without a bot token instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const envelope = await signedEnvelope(reactionAddedBody(DECISION_REACTION));
    const outcome = await slackConnector.handleWebhook(
      baseCtx({ secret: null }),
      envelope,
    );

    expect(outcome.audit).toBe("slack.reaction.decision_skipped_no_token");
    expect(mockProposeSlackDecisionCandidate).not.toHaveBeenCalled();
  });

  it("skips when the thread fetch fails, never throwing out of handleWebhook", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const envelope = await signedEnvelope(reactionAddedBody(DECISION_REACTION));
    const outcome = await slackConnector.handleWebhook(baseCtx(), envelope);

    expect(outcome.audit).toBe("slack.reaction.decision_skipped_no_thread");
    expect(mockProposeSlackDecisionCandidate).not.toHaveBeenCalled();
  });

  it("still proposes the candidate with permalink: null when chat.getPermalink fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("conversations.replies")) {
          return {
            json: async () => ({
              ok: true,
              messages: [{ user: "U1", text: "Decision time.", ts: "100.200" }],
            }),
          };
        }
        if (url.includes("chat.getPermalink")) {
          return { json: async () => ({ ok: false, error: "missing_scope" }) };
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const envelope = await signedEnvelope(reactionAddedBody(DECISION_REACTION));
    const outcome = await slackConnector.handleWebhook(baseCtx(), envelope);

    expect(outcome.audit).toBe("slack.reaction.decision_captured");
    expect(mockProposeSlackDecisionCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ permalink: null }),
    );
  });
});
