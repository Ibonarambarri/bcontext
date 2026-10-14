import { describe, expect, it } from "vitest";
import { oklchToHex } from "@bcontext-dev/contract/graph/color";
import { GRADIENTS } from "@bcontext-dev/contract/workspace-gradients";

/**
 * Expected values computed with an independent reference implementation
 * (culori 4.x, same per-channel gamut clamp). The converter must land within
 * ±1/255 per channel of the reference.
 */
function expectHexClose(actual: string, expected: string, tolerance = 1) {
  expect(actual).toMatch(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/);
  for (let i = 1; i < expected.length; i += 2) {
    const actualByte = parseInt(actual.slice(i, i + 2), 16);
    const expectedByte = parseInt(expected.slice(i, i + 2), 16);
    expect(Math.abs(actualByte - expectedByte), `${actual} vs ${expected} @${i}`).toBeLessThanOrEqual(tolerance);
  }
}

describe("oklchToHex", () => {
  it("converts exact achromatic anchors", () => {
    expect(oklchToHex("oklch(0% 0 0)")).toBe("#000000");
    expect(oklchToHex("oklch(100% 0 0)")).toBe("#ffffff");
    expect(oklchToHex("oklch(50% 0 0)")).toBe("#636363");
    // Hue is irrelevant at zero chroma.
    expect(oklchToHex("oklch(75% 0 120)")).toBe("#aeaeae");
  });

  it("converts the sRGB primaries from their OKLCH coordinates", () => {
    expectHexClose(oklchToHex("oklch(62.796% 0.25768 29.234)"), "#ff0000");
    expectHexClose(oklchToHex("oklch(86.644% 0.29483 142.495)"), "#00ff00");
    expectHexClose(oklchToHex("oklch(45.201% 0.31321 264.052)"), "#0000ff");
  });

  it("converts the forest hub green used by the default workspace gradient", () => {
    // oklch(62% 0.16 145) ≈ medium green (reference: #399e43).
    expectHexClose(oklchToHex("oklch(62% 0.16 145)"), "#399e43");
  });

  it("converts every workspace gradient stop to a Sigma-parseable hex within tolerance", () => {
    const expected: Record<string, [string, string]> = {
      forest: ["#399e43", "#cb9317"],
      ocean: ["#1f7dcf", "#00b7c1"], // `to` is out of gamut — clamped like browsers do
      ember: ["#ec5d4b", "#e18528"],
      orchid: ["#b668c8", "#8184f1"],
      rose: ["#db4b6d", "#d37db8"],
      slate: ["#517791", "#7aa8ab"],
    };
    for (const gradient of GRADIENTS) {
      const [from, to] = expected[gradient.id]!;
      expectHexClose(oklchToHex(gradient.from), from);
      expectHexClose(oklchToHex(gradient.to), to);
    }
  });

  it("accepts number lightness, deg hue suffix and alpha", () => {
    expectHexClose(oklchToHex("oklch(0.62 0.16 145deg)"), "#399e43");
    expect(oklchToHex("oklch(100% 0 0 / 50%)")).toBe("#ffffff80");
    expect(oklchToHex("oklch(100% 0 0 / 1)")).toBe("#ffffff");
  });

  it("passes non-oklch colors through untouched", () => {
    expect(oklchToHex("#62966d")).toBe("#62966d");
    expect(oklchToHex("rgb(10, 20, 30)")).toBe("rgb(10, 20, 30)");
    expect(oklchToHex("")).toBe("");
  });
});
