import { afterEach, describe, expect, it, vi } from "vitest";

const mockRetrieve = vi.fn();
vi.mock("@/lib/rag", () => ({
  retrieve: (...args: Parameters<typeof mockRetrieve>) => mockRetrieve(...args),
}));

const proposed: Record<string, unknown>[] = [];
vi.mock("@/lib/ingest/candidates", () => ({
  proposeCandidate: async (input: Record<string, unknown>) => {
    proposed.push(input);
    return { ...input, id: `cand-${proposed.length}`, status: "pending" };
  },
}));

import { proposeMeetingCandidates } from "./candidates";

const REFINED_MD = `# Q3 planning sync
_A quick TL;DR._

**Participantes** — Alice, Bob · **Duración** — 30 min

## Temas
### Roadmap
- discussed Q3 priorities

## Decisiones
- We will ship the new billing flow before Q3 ends
- Postpone the mobile app to Q4

## Action items
- [ ] Write the billing migration plan — @alice (due: Friday)
- [ ] Follow up with design — @bob

## Preguntas abiertas
- Do we need a beta flag?

## Citas clave
- **Alice · 00:18** — "Let's ship it."`;

describe("proposeMeetingCandidates", () => {
  afterEach(() => {
    proposed.length = 0;
    mockRetrieve.mockReset();
  });

  it("proposes one candidate per decision and per action item, linked caused_by to the meeting", async () => {
    mockRetrieve.mockResolvedValue([]);
    const result = await proposeMeetingCandidates({
      workspaceId: "ws-1",
      workspaceSlug: "acme",
      meetingNodeId: "node-meeting-1",
      refinedMd: REFINED_MD,
      participants: ["Alice", "Bob"],
    });

    expect(result).toEqual({ proposed: 4, skippedDuplicate: 0 });
    expect(proposed).toHaveLength(4);

    const decisionCandidates = proposed.filter((p) => p.kind === "decision");
    expect(decisionCandidates).toHaveLength(2);
    expect(decisionCandidates[0]).toMatchObject({
      source: "meeting",
      externalId: "node-meeting-1:decision:0",
      title: "We will ship the new billing flow before Q3 ends",
      links: [{ to_node_id: "node-meeting-1", relation: "caused_by" }],
    });

    const taskCandidates = proposed.filter((p) => p.kind === "task");
    expect(taskCandidates).toHaveLength(2);
    expect(taskCandidates[0]).toMatchObject({
      externalId: "node-meeting-1:action:0",
      title: "Write the billing migration plan — @alice (due: Friday)",
    });
    expect((taskCandidates[0]!.provenance as Record<string, unknown>).owner).toBe("alice");
  });

  it("skips proposing when a near-duplicate node already exists", async () => {
    mockRetrieve.mockResolvedValue([{ node_id: "existing", similarity: 0.92 }]);
    const result = await proposeMeetingCandidates({
      workspaceId: "ws-1",
      workspaceSlug: "acme",
      meetingNodeId: "node-meeting-1",
      refinedMd: REFINED_MD,
      participants: [],
    });
    expect(result).toEqual({ proposed: 0, skippedDuplicate: 4 });
    expect(proposed).toHaveLength(0);
  });

  it("does not skip on a low-similarity hit", async () => {
    mockRetrieve.mockResolvedValue([{ node_id: "unrelated", similarity: 0.3 }]);
    const result = await proposeMeetingCandidates({
      workspaceId: "ws-1",
      workspaceSlug: "acme",
      meetingNodeId: "node-meeting-1",
      refinedMd: REFINED_MD,
      participants: [],
    });
    expect(result.proposed).toBe(4);
  });

  it("never blocks proposing when the dedupe retrieval call fails", async () => {
    mockRetrieve.mockRejectedValue(new Error("gateway down"));
    const result = await proposeMeetingCandidates({
      workspaceId: "ws-1",
      workspaceSlug: "acme",
      meetingNodeId: "node-meeting-1",
      refinedMd: REFINED_MD,
      participants: [],
    });
    expect(result.proposed).toBe(4);
  });

  it("returns zero candidates when the refined doc has no Decisiones/Action items sections", async () => {
    mockRetrieve.mockResolvedValue([]);
    const result = await proposeMeetingCandidates({
      workspaceId: "ws-1",
      workspaceSlug: "acme",
      meetingNodeId: "node-meeting-1",
      refinedMd: "# Just a title\n\nNo structured sections here.",
      participants: [],
    });
    expect(result).toEqual({ proposed: 0, skippedDuplicate: 0 });
  });
});
