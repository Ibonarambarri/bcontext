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

const mockRetrieveScoped = vi.fn();
vi.mock("@/lib/rag", () => ({
  retrieveScoped: (...args: unknown[]) => mockRetrieveScoped(...args),
}));

const mockGetStorageById = vi.fn();
vi.mock("@/lib/storage", () => ({
  getStorageById: (...args: unknown[]) => mockGetStorageById(...args),
}));

import {
  isCandidateWorthyIssue,
  isCandidateWorthyMergedPr,
  proposeGithubIssueCandidate,
  proposeGithubMergedPrCandidate,
  ISSUE_MIN_BODY_LENGTH,
  PR_MIN_CHANGED_LINES,
} from "./github";

describe("isCandidateWorthyMergedPr", () => {
  it("rejects unmerged PRs", () => {
    expect(
      isCandidateWorthyMergedPr({
        number: 1,
        title: "Add feature",
        body: "body",
        html_url: "https://x",
        merged: false,
        additions: 100,
        deletions: 0,
      }),
    ).toBe(false);
  });

  it("rejects bot-authored PRs", () => {
    expect(
      isCandidateWorthyMergedPr({
        number: 1,
        title: "Bump deps",
        body: null,
        html_url: "https://x",
        merged: true,
        additions: 200,
        deletions: 5,
        user: { login: "dependabot[bot]" },
      }),
    ).toBe(false);
  });

  it("rejects trivial dependency/lockfile titles", () => {
    expect(
      isCandidateWorthyMergedPr({
        number: 1,
        title: "chore(deps): bump foo to 2.0",
        body: null,
        html_url: "https://x",
        merged: true,
        additions: 500,
        deletions: 500,
      }),
    ).toBe(false);
  });

  it("rejects diffs under the changed-lines threshold", () => {
    expect(
      isCandidateWorthyMergedPr({
        number: 1,
        title: "Fix typo",
        body: "fix",
        html_url: "https://x",
        merged: true,
        additions: 1,
        deletions: 1,
      }),
    ).toBe(false);
  });

  it("accepts a real merged PR above the threshold", () => {
    expect(
      isCandidateWorthyMergedPr({
        number: 1,
        title: "Add retry logic to the webhook queue",
        body: "Adds exponential backoff.",
        html_url: "https://x",
        merged: true,
        additions: PR_MIN_CHANGED_LINES,
        deletions: 0,
      }),
    ).toBe(true);
  });
});

describe("isCandidateWorthyIssue", () => {
  it("rejects issues with a thin body", () => {
    expect(
      isCandidateWorthyIssue({
        number: 1,
        title: "Bug",
        body: "oops",
        html_url: "https://x",
      }),
    ).toBe(false);
  });

  it("rejects issues with no body", () => {
    expect(
      isCandidateWorthyIssue({
        number: 1,
        title: "Bug",
        body: null,
        html_url: "https://x",
      }),
    ).toBe(false);
  });

  it("rejects bot-authored issues", () => {
    expect(
      isCandidateWorthyIssue({
        number: 1,
        title: "Automated report",
        body: "x".repeat(ISSUE_MIN_BODY_LENGTH + 10),
        html_url: "https://x",
        user: { login: "some-ci[bot]" },
      }),
    ).toBe(false);
  });

  it("accepts an issue with a substantial body", () => {
    expect(
      isCandidateWorthyIssue({
        number: 1,
        title: "Login fails on Safari",
        body: "x".repeat(ISSUE_MIN_BODY_LENGTH),
        html_url: "https://x",
      }),
    ).toBe(true);
  });
});

describe("proposeGithubMergedPrCandidate", () => {
  afterEach(() => {
    mockExtractCandidate.mockReset();
    mockProposeCandidate.mockReset();
    mockRetrieveScoped.mockReset();
    mockGetStorageById.mockReset();
  });

  it("extracts, proposes with provenance, and attaches semantic links", async () => {
    mockExtractCandidate.mockResolvedValue({
      kind: "task",
      title: "Add retry logic",
      contentMd: "## Objetivo\n\nRetry.",
      confidence: 0.8,
    });
    mockGetStorageById.mockResolvedValue({ workspace: { slug: "acme" } });
    mockRetrieveScoped.mockResolvedValue({
      hits: [
        { node_id: "n-1", title: "Queue design", kind: "doc", content: "", similarity: 0.9, chunk_index: null, block_id: null },
        { node_id: "n-2", title: "Retry ADR", kind: "adr", content: "", similarity: 0.8, chunk_index: null, block_id: null },
      ],
    });

    await proposeGithubMergedPrCandidate({
      workspaceId: "ws-1",
      repo: { full_name: "Bcontext-dev/bcontext" },
      pr: {
        number: 42,
        title: "Add retry logic",
        body: "Adds backoff.",
        html_url: "https://github.com/x/y/pull/42",
        merged: true,
        user: { login: "octocat" },
      },
    });

    expect(mockProposeCandidate).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr:Bcontext-dev/bcontext:42",
      kind: "task",
      title: "Add retry logic",
      contentMd: "## Objetivo\n\nRetry.",
      confidence: 0.8,
      links: [
        { to_node_id: "n-1", relation: "references" },
        { to_node_id: "n-2", relation: "references" },
      ],
      triage: true,
      provenance: {
        repo: "Bcontext-dev/bcontext",
        number: 42,
        url: "https://github.com/x/y/pull/42",
        author: "octocat",
      },
    });
  });

  it("skips proposing when extraction fails, without throwing", async () => {
    mockExtractCandidate.mockRejectedValue(new Error("gateway 500"));

    await expect(
      proposeGithubMergedPrCandidate({
        workspaceId: "ws-1",
        repo: { full_name: "Bcontext-dev/bcontext" },
        pr: {
          number: 1,
          title: "Add feature",
          body: "body",
          html_url: "https://x",
          merged: true,
        },
      }),
    ).resolves.toBeUndefined();

    expect(mockProposeCandidate).not.toHaveBeenCalled();
  });

  it("proposes with no links when retrieval fails", async () => {
    mockExtractCandidate.mockResolvedValue({
      kind: "task",
      title: "T",
      contentMd: "## Objetivo\n\nT.",
      confidence: 0.5,
    });
    mockGetStorageById.mockRejectedValue(new Error("db down"));

    await proposeGithubMergedPrCandidate({
      workspaceId: "ws-1",
      repo: { full_name: "Bcontext-dev/bcontext" },
      pr: { number: 1, title: "T", body: "b", html_url: "https://x", merged: true },
    });

    expect(mockProposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ links: [] }),
    );
  });
});

describe("proposeGithubIssueCandidate", () => {
  afterEach(() => {
    mockExtractCandidate.mockReset();
    mockProposeCandidate.mockReset();
    mockRetrieveScoped.mockReset();
    mockGetStorageById.mockReset();
  });

  it("extracts and proposes with issue provenance", async () => {
    mockExtractCandidate.mockResolvedValue({
      kind: "bug",
      title: "Login fails on Safari",
      contentMd: "## Repro\n\nSteps.",
      confidence: 0.7,
    });
    mockGetStorageById.mockResolvedValue({ workspace: { slug: "acme" } });
    mockRetrieveScoped.mockResolvedValue({ hits: [] });

    await proposeGithubIssueCandidate({
      workspaceId: "ws-1",
      repo: { full_name: "Bcontext-dev/bcontext" },
      issue: {
        number: 7,
        title: "Login fails on Safari",
        body: "Steps to repro...",
        html_url: "https://github.com/x/y/issues/7",
        user: { login: "reporter" },
      },
    });

    expect(mockProposeCandidate).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      source: "github",
      externalId: "issue:Bcontext-dev/bcontext:7",
      kind: "bug",
      title: "Login fails on Safari",
      contentMd: "## Repro\n\nSteps.",
      confidence: 0.7,
      links: [],
      triage: true,
      provenance: {
        repo: "Bcontext-dev/bcontext",
        number: 7,
        url: "https://github.com/x/y/issues/7",
        author: "reporter",
      },
    });
  });
});
