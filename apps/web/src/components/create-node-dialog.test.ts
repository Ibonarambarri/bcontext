import { describe, expect, it } from "vitest";
import { KIND_OPTIONS } from "./create-node-dialog";

describe("canonical node creation", () => {
  it("offers only semantic node kinds", () => {
    expect(KIND_OPTIONS.map((option) => option.kind)).not.toContain("folder");
  });
});
