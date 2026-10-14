import { afterEach, describe, expect, it, vi } from "vitest";

const mockExtractCandidate = vi.fn();
vi.mock("@/lib/ingest/extract", () => ({
  extractCandidate: (args: Parameters<typeof mockExtractCandidate>[0]) =>
    mockExtractCandidate(args),
  ExtractCandidateError: class ExtractCandidateError extends Error {
    code: string;
    constructor(code: string, message?: string) {
      super(message ?? code);
      this.code = code;
    }
  },
}));

const mockProposeCandidate = vi.fn();
vi.mock("@/lib/ingest/candidates", () => ({
  proposeCandidate: (args: Parameters<typeof mockProposeCandidate>[0]) =>
    mockProposeCandidate(args),
}));

import {
  buildThreadRawText,
  distinctParticipants,
  proposeSlackDecisionCandidate,
} from "./slack";

describe("buildThreadRawText", () => {
  it("concatenates speaker-attributed lines by user id", () => {
    const text = buildThreadRawText([
      { user: "U1", text: "Should we ship on Friday?", ts: "1.1" },
      { user: "U2", text: "Yes, let's do it.", ts: "1.2" },
    ]);
    expect(text).toBe(
      "<@U1>: Should we ship on Friday?\n<@U2>: Yes, let's do it.",
    );
  });

  it("falls back to 'unknown' when a message has no user", () => {
    const text = buildThreadRawText([{ text: "anonymous", ts: "1.1" }]);
    expect(text).toBe("<@unknown>: anonymous");
  });
});

describe("distinctParticipants", () => {
  it("dedupes user ids and drops missing ones", () => {
    const participants = distinctParticipants([
      { user: "U1", ts: "1.1" },
      { user: "U2", ts: "1.2" },
      { user: "U1", ts: "1.3" },
      { ts: "1.4" },
    ]);
    expect(participants.sort()).toEqual(["U1", "U2"]);
  });
});

describe("proposeSlackDecisionCandidate", () => {
  afterEach(() => {
    mockExtractCandidate.mockReset();
    mockProposeCandidate.mockReset();
  });

  it("forces kind 'decision' regardless of what extractCandidate returns", async () => {
    mockExtractCandidate.mockResolvedValue({
      kind: "task",
      title: "Ship on Friday",
      contentMd: "## Decisión\n\nShip on Friday.",
      confidence: 0.8,
    });

    await proposeSlackDecisionCandidate({
      workspaceId: "ws-1",
      channel: "C1",
      threadTs: "100.200",
      messages: [{ user: "U1", text: "Ship on Friday?", ts: "100.200" }],
      permalink: "https://x.slack.com/archives/C1/p100200",
    });

    expect(mockProposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "slack",
        externalId: "thread:C1:100.200",
        kind: "decision",
        title: "Ship on Friday",
      }),
    );
  });

  it("includes channel/thread_ts/permalink/participants in provenance", async () => {
    mockExtractCandidate.mockResolvedValue({
      kind: "decision",
      title: "Ship on Friday",
      contentMd: "## Decisión\n\nShip on Friday.",
      confidence: 0.9,
    });

    await proposeSlackDecisionCandidate({
      workspaceId: "ws-1",
      channel: "C1",
      threadTs: "100.200",
      messages: [
        { user: "U1", text: "Ship on Friday?", ts: "100.200" },
        { user: "U2", text: "Agreed.", ts: "100.201" },
      ],
      permalink: "https://x.slack.com/archives/C1/p100200",
    });

    expect(mockProposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: {
          channel: "C1",
          thread_ts: "100.200",
          permalink: "https://x.slack.com/archives/C1/p100200",
          participants: ["U1", "U2"],
        },
      }),
    );
  });

  it("skips proposing when extractCandidate throws", async () => {
    mockExtractCandidate.mockRejectedValue(new Error("model_error"));

    await proposeSlackDecisionCandidate({
      workspaceId: "ws-1",
      channel: "C1",
      threadTs: "100.200",
      messages: [{ user: "U1", text: "hi", ts: "100.200" }],
      permalink: null,
    });

    expect(mockProposeCandidate).not.toHaveBeenCalled();
  });
});
