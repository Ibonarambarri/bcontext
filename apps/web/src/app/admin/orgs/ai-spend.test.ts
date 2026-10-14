import { describe, expect, it } from "vitest";
import { formatUsd } from "./ai-spend";

/**
 * The money the operator checks against the gateway's invoice: cents once
 * the figure is a dollar, four decimals below that so a month of embeddings
 * is a number and not "$0.00".
 */
describe("formatUsd", () => {
  it("prints cents from a dollar up", () => {
    expect(formatUsd(6.380786)).toBe("$6.38");
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });

  it("keeps four decimals below a dollar so small spend stays visible", () => {
    expect(formatUsd(0.433519)).toBe("$0.4335");
    expect(formatUsd(0.000059)).toBe("$0.0001");
    expect(formatUsd(0.25)).toBe("$0.25");
    expect(formatUsd(0)).toBe("$0.00");
  });
});
