import { describe, it, expect } from "vitest";
import { selectEndpointsForEvent } from "./dispatch";

function ep(over: Partial<{
  id: string;
  url: string;
  event_types: string[];
  secret_hash: string;
  paused: boolean;
}>) {
  return {
    id: over.id ?? "e1",
    url: over.url ?? "https://example.com/hook",
    event_types: over.event_types ?? ["node.created"],
    secret_hash: over.secret_hash ?? "deadbeef",
    paused: over.paused ?? false,
  };
}

describe("selectEndpointsForEvent", () => {
  it("returns only endpoints subscribed to the event type", () => {
    const out = selectEndpointsForEvent(
      [
        ep({ id: "a", event_types: ["node.created"] }),
        ep({ id: "b", event_types: ["node.updated"] }),
        ep({ id: "c", event_types: ["node.created", "node.deleted"] }),
      ],
      "node.created",
    );
    expect(out.map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("filters out paused endpoints", () => {
    const out = selectEndpointsForEvent(
      [
        ep({ id: "a", paused: true, event_types: ["*"] }),
        ep({ id: "b", paused: false, event_types: ["*"] }),
      ],
      "node.created",
    );
    expect(out.map((e) => e.id)).toEqual(["b"]);
  });

  it("dedupes endpoints by id", () => {
    const dup = ep({ id: "x", event_types: ["*"] });
    const out = selectEndpointsForEvent([dup, dup, dup], "node.deleted");
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("x");
  });

  it("respects the `*` wildcard", () => {
    const out = selectEndpointsForEvent(
      [ep({ id: "w", event_types: ["*"] })],
      "skill.invoked",
    );
    expect(out).toHaveLength(1);
  });

  it("returns nothing when no endpoints match", () => {
    const out = selectEndpointsForEvent(
      [ep({ id: "a", event_types: ["node.updated"] })],
      "node.created",
    );
    expect(out).toEqual([]);
  });

  it("handles missing event_types as empty (no match)", () => {
    const out = selectEndpointsForEvent(
      [
        {
          id: "e",
          url: "u",
          event_types: [] as string[],
          secret_hash: "h",
          paused: false,
        },
      ],
      "node.created",
    );
    expect(out).toEqual([]);
  });
});
