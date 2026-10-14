import { describe, expect, it } from "vitest";
import {
  TAG_HUE_BUCKETS,
  tagColorCss,
  tagHueDegrees,
  tagIdentity,
  tagNodeColor,
} from "./tag-color";

const A = "0f4c3a1e-2b7d-4c8f-9a10-5e6d7c8b9a01";
const B = "7a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";

describe("tag color", () => {
  it("derives the hue from the tag id, not from rank or usage", () => {
    // The whole point: the same id always lands on the same hue, so a tag
    // does not change color when nodes are assigned to it or to a sibling,
    // and every surface that names the tag can compute the same color.
    expect(tagHueDegrees(A)).toBe(tagHueDegrees(A));
    expect(tagHueDegrees(B)).toBe(tagHueDegrees(B));
  });

  it("quantizes onto the bucket grid, so colors that differ differ clearly", () => {
    // Two tags may share a hue (see the module docs); what must not happen is
    // a pair landing a few degrees apart, which reads as a rendering error
    // rather than as two colors.
    const step = 360 / TAG_HUE_BUCKETS;
    for (const id of [A, B, "x", "tag:zzz", crypto.randomUUID()]) {
      const hue = tagHueDegrees(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(hue % step).toBeCloseTo(0, 10);
    }
  });

  it("addresses a tag by bare id and by graph resource id identically", () => {
    expect(tagIdentity(`tag:${A}`)).toBe(A);
    expect(tagHueDegrees(`tag:${A}`)).toBe(tagHueDegrees(A));
  });

  it("spreads a realistic tag set over most of the wheel", () => {
    // Not a uniqueness guarantee — the hash is allowed to collide — but the
    // spread has to be wide enough that a workspace does not come out
    // monochrome by accident.
    const ids = Array.from({ length: 16 }, () => crypto.randomUUID());
    expect(new Set(ids.map((id) => tagHueDegrees(id))).size).toBeGreaterThan(6);
  });

  it("hands Sigma hex, never oklch — an oklch fill renders as opaque black", () => {
    expect(tagNodeColor(tagHueDegrees(A), false)).toMatch(/^#[0-9a-f]{6}$/i);
    expect(tagNodeColor(tagHueDegrees(A), true)).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("lifts nested tags toward the paper without leaving the hue family", () => {
    const hue = tagHueDegrees(A);
    const root = tagNodeColor(hue, false, 1);
    const child = tagNodeColor(hue, false, 2);
    const grandchild = tagNodeColor(hue, false, 3);
    expect(new Set([root, child, grandchild]).size).toBe(3);
    // Depth is capped: past the tier ceiling the color stops drifting.
    expect(tagNodeColor(hue, false, 9)).toBe(tagNodeColor(hue, false, 4));
  });

  it("keeps the DOM variant theme-agnostic so one string works in both", () => {
    // Lightness/chroma come from CSS custom properties (globals.css), so the
    // chip flips with the theme and inside a scoped theme island.
    expect(tagColorCss(A)).toBe(`oklch(var(--tag-l) var(--tag-c) ${tagHueDegrees(A).toFixed(1)})`);
  });
});
