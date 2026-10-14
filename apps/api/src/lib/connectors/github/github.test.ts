import { afterEach, describe, expect, it, vi } from "vitest";

const mockProposeGithubMergedPrCandidate = vi.fn();
const mockProposeGithubIssueCandidate = vi.fn();
const mockIsCandidateWorthyMergedPr = vi.fn();
const mockIsCandidateWorthyIssue = vi.fn();
vi.mock("@/lib/ingest/extractors/github", () => ({
  proposeGithubMergedPrCandidate: (...args: unknown[]) =>
    mockProposeGithubMergedPrCandidate(...args),
  proposeGithubIssueCandidate: (...args: unknown[]) =>
    mockProposeGithubIssueCandidate(...args),
  isCandidateWorthyMergedPr: (...args: unknown[]) => mockIsCandidateWorthyMergedPr(...args),
  isCandidateWorthyIssue: (...args: unknown[]) => mockIsCandidateWorthyIssue(...args),
}));

import {
  githubInstallationId,
  githubInstallStatusFromWebhook,
  githubConnector,
  verifyHubSignature,
} from "./index";

async function signedEnvelope(payload: Record<string, unknown>, event: string) {
  const secret = "test-webhook-secret";
  const rawBody = JSON.stringify(payload);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    rawBody,
    headers: {
      "x-hub-signature-256": `sha256=${hex}`,
      "x-github-event": event,
    },
  };
}

const fakeCtx = {
  workspaceId: "ws-1",
  installId: "install-1",
  config: {},
  secret: null,
};

describe("github — handleWebhook candidate routing (NEXO-02)", () => {
  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;

  afterEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    mockProposeGithubMergedPrCandidate.mockReset();
    mockProposeGithubIssueCandidate.mockReset();
    mockIsCandidateWorthyMergedPr.mockReset();
    mockIsCandidateWorthyIssue.mockReset();
  });

  it("routes a candidate-worthy merged PR through the candidate pipeline, no direct node", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
    mockIsCandidateWorthyMergedPr.mockReturnValue(true);
    const envelope = await signedEnvelope(
      {
        action: "closed",
        pull_request: {
          id: 1,
          number: 42,
          title: "Add retry logic",
          body: "Adds backoff.",
          state: "closed",
          html_url: "https://github.com/x/y/pull/42",
          merged: true,
          additions: 100,
          deletions: 10,
          user: { login: "dev" },
        },
        repository: { full_name: "x/y", default_branch: "main" },
      },
      "pull_request",
    );

    const outcome = await githubConnector.handleWebhook(fakeCtx, envelope);

    expect(mockProposeGithubMergedPrCandidate).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      repo: { full_name: "x/y" },
      pr: expect.objectContaining({ number: 42, merged: true }),
    });
    expect(outcome.nodes).toEqual([]);
  });

  it("does not propose a candidate for a merged PR filtered out by the cheap heuristic", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
    mockIsCandidateWorthyMergedPr.mockReturnValue(false);
    const envelope = await signedEnvelope(
      {
        action: "closed",
        pull_request: {
          id: 1,
          number: 43,
          title: "Fix typo",
          body: "typo",
          state: "closed",
          html_url: "https://github.com/x/y/pull/43",
          merged: true,
          additions: 1,
          deletions: 1,
        },
        repository: { full_name: "x/y", default_branch: "main" },
      },
      "pull_request",
    );

    const outcome = await githubConnector.handleWebhook(fakeCtx, envelope);

    expect(mockProposeGithubMergedPrCandidate).not.toHaveBeenCalled();
    expect(outcome.nodes).toEqual([]);
  });

  it("keeps the existing direct-node behavior for a closed-but-unmerged PR", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
    const envelope = await signedEnvelope(
      {
        action: "closed",
        pull_request: {
          id: 1,
          number: 44,
          title: "Abandoned PR",
          body: "nope",
          state: "closed",
          html_url: "https://github.com/x/y/pull/44",
          merged: false,
        },
        repository: { full_name: "x/y", default_branch: "main" },
      },
      "pull_request",
    );

    const outcome = await githubConnector.handleWebhook(fakeCtx, envelope);

    expect(mockProposeGithubMergedPrCandidate).not.toHaveBeenCalled();
    expect(outcome.nodes).toHaveLength(1);
    expect(outcome.nodes[0]).toMatchObject({ kind: "task", status: "done" });
  });

  it("routes a candidate-worthy opened issue through the candidate pipeline, no direct node", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
    mockIsCandidateWorthyIssue.mockReturnValue(true);
    const envelope = await signedEnvelope(
      {
        action: "opened",
        issue: {
          id: 1,
          number: 7,
          title: "Login fails on Safari",
          body: "Detailed repro steps go here.",
          state: "open",
          html_url: "https://github.com/x/y/issues/7",
          user: { login: "reporter" },
        },
        repository: { full_name: "x/y", default_branch: "main" },
      },
      "issues",
    );

    const outcome = await githubConnector.handleWebhook(fakeCtx, envelope);

    expect(mockProposeGithubIssueCandidate).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      repo: { full_name: "x/y" },
      issue: expect.objectContaining({ number: 7 }),
    });
    expect(outcome.nodes).toEqual([]);
  });

  it("falls back to the direct node path for a thin (filtered-out) issue", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
    mockIsCandidateWorthyIssue.mockReturnValue(false);
    const envelope = await signedEnvelope(
      {
        action: "opened",
        issue: {
          id: 1,
          number: 8,
          title: "Quick question",
          body: "?",
          state: "open",
          html_url: "https://github.com/x/y/issues/8",
        },
        repository: { full_name: "x/y", default_branch: "main" },
      },
      "issues",
    );

    const outcome = await githubConnector.handleWebhook(fakeCtx, envelope);

    expect(mockProposeGithubIssueCandidate).not.toHaveBeenCalled();
    expect(outcome.nodes).toHaveLength(1);
    expect(outcome.nodes[0]).toMatchObject({ kind: "task" });
  });

  it("never routes an edited issue through candidates even when the filter would pass", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
    mockIsCandidateWorthyIssue.mockReturnValue(true);
    const envelope = await signedEnvelope(
      {
        action: "edited",
        issue: {
          id: 1,
          number: 9,
          title: "Edited issue",
          body: "A long, substantial body describing the issue in detail.",
          state: "open",
          html_url: "https://github.com/x/y/issues/9",
        },
        repository: { full_name: "x/y", default_branch: "main" },
      },
      "issues",
    );

    const outcome = await githubConnector.handleWebhook(fakeCtx, envelope);

    expect(mockProposeGithubIssueCandidate).not.toHaveBeenCalled();
    expect(outcome.nodes).toHaveLength(1);
  });
});

describe("github — verifyHubSignature", () => {
  const secret = "shhh";
  const body = '{"hello":"world"}';
  // Pre-computed: HMAC-SHA256(secret, body) in hex
  // openssl dgst -sha256 -hmac shhh
  const valid = "sha256=ba7f3d49d2cbfe2c220e8c2da3b04a91f0c2dbe6d5fe5d2f7ad4ed87aa8b4eee";

  it("accepts a valid sha256= signature", async () => {
    // Re-derive expected for the assertion to stay deterministic against
    // future spec changes.
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(await verifyHubSignature(secret, body, `sha256=${hex}`)).toBe(true);
  });

  it("rejects wrong signature", async () => {
    expect(await verifyHubSignature(secret, body, valid)).toBe(false);
  });

  it("rejects missing sha256= prefix", async () => {
    expect(await verifyHubSignature(secret, body, "deadbeef")).toBe(false);
  });

  it("rejects empty header", async () => {
    expect(await verifyHubSignature(secret, body, "")).toBe(false);
  });
});

describe("github — installation id", () => {
  it("accepts positive integer ids from callbacks and persisted config", () => {
    expect(githubInstallationId({ installation_id: "12345" })).toBe(12345);
    expect(githubInstallationId({ installation_id: 67890 })).toBe(67890);
  });

  it("rejects missing, fractional, negative and malformed ids", () => {
    expect(githubInstallationId({})).toBeNull();
    expect(githubInstallationId({ installation_id: "nope" })).toBeNull();
    expect(githubInstallationId({ installation_id: -1 })).toBeNull();
    expect(githubInstallationId({ installation_id: 1.5 })).toBeNull();
  });
});

describe("github — installation lifecycle", () => {
  it.each([
    ["deleted", "uninstalled"],
    ["suspend", "paused"],
    ["unsuspend", "active"],
  ] as const)("maps %s to %s", (action, status) => {
    expect(
      githubInstallStatusFromWebhook("installation", { action }),
    ).toBe(status);
  });

  it("ignores unrelated events and installation actions", () => {
    expect(
      githubInstallStatusFromWebhook("issues", { action: "deleted" }),
    ).toBeNull();
    expect(
      githubInstallStatusFromWebhook("installation", { action: "created" }),
    ).toBeNull();
  });
});
