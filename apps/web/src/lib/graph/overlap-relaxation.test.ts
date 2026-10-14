import { describe, expect, it } from "vitest";
import { relaxNodeOverlaps, type OverlapRelaxationNode } from "./organic-layout";

function separation(
  points: Map<string, { x: number; y: number }>,
  a: string,
  b: string,
): number {
  const pointA = points.get(a)!;
  const pointB = points.get(b)!;
  return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
}

describe("relaxNodeOverlaps", () => {
  it("separates overlapping nodes", () => {
    const nodes: OverlapRelaxationNode[] = [
      { id: "a", x: 0, y: 0, size: 6 },
      { id: "b", x: 0.2, y: 0, size: 6 },
    ];
    const before = Math.hypot(0.2, 0);
    const after = separation(relaxNodeOverlaps(nodes), "a", "b");
    expect(after).toBeGreaterThan(before);
  });

  it("leaves nodes that already clear each other exactly where they are", () => {
    const nodes: OverlapRelaxationNode[] = [
      { id: "a", x: -20, y: 0, size: 6 },
      { id: "b", x: 20, y: 0, size: 6 },
    ];
    const relaxed = relaxNodeOverlaps(nodes);
    expect(relaxed.get("a")).toEqual({ x: -20, y: 0 });
    expect(relaxed.get("b")).toEqual({ x: 20, y: 0 });
  });

  it("never moves a fixed node — the hub, the tag ring, a user's drag", () => {
    const nodes: OverlapRelaxationNode[] = [
      { id: "hub", x: 0, y: 0, size: 12, fixed: true },
      { id: "content", x: 0.1, y: 0, size: 6 },
    ];
    const relaxed = relaxNodeOverlaps(nodes);
    expect(relaxed.get("hub")).toEqual({ x: 0, y: 0 });
    expect(relaxed.get("content")!.x).toBeGreaterThan(0.1);
  });

  it("separates exactly co-located nodes instead of dividing by zero", () => {
    const nodes: OverlapRelaxationNode[] = [
      { id: "a", x: 3, y: 3, size: 6 },
      { id: "b", x: 3, y: 3, size: 6 },
    ];
    const relaxed = relaxNodeOverlaps(nodes);
    expect(separation(relaxed, "a", "b")).toBeGreaterThan(0);
    expect(Number.isFinite(relaxed.get("a")!.x)).toBe(true);
    expect(Number.isFinite(relaxed.get("b")!.y)).toBe(true);
  });

  it("is deterministic — the same seed layout settles to the same map", () => {
    const nodes: OverlapRelaxationNode[] = Array.from({ length: 12 }, (_, index) => ({
      id: `n${index}`,
      x: Math.cos(index) * 0.4,
      y: Math.sin(index) * 0.4,
      size: 6,
    }));
    expect([...relaxNodeOverlaps(nodes)]).toEqual([...relaxNodeOverlaps(nodes)]);
  });

  it("keeps the designed geometry: a relaxed node stays near its seed", () => {
    // This is the contract that makes it usable in place of ForceAtlas2 —
    // it resolves overlaps, it does not re-arrange the map.
    const nodes: OverlapRelaxationNode[] = Array.from({ length: 8 }, (_, index) => ({
      id: `n${index}`,
      x: index * 0.3,
      y: 0,
      size: 6,
    }));
    const relaxed = relaxNodeOverlaps(nodes);
    for (const node of nodes) {
      const point = relaxed.get(node.id)!;
      expect(Math.hypot(point.x - node.x, point.y - node.y)).toBeLessThan(12);
    }
  });
});
