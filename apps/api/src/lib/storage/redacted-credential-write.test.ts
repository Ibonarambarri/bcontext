import { describe, expect, it } from "vitest";
import { assertNodeDataContract, NodeWriteError } from "./index";

/**
 * The companion guard to `scopedStorage({ maskCredentials: true })`: a
 * principal that read a credential redacted must not be able to write that
 * copy back and destroy the real value.
 */
describe("writing back a redacted credential", () => {
  it("is refused", () => {
    expect(() =>
      assertNodeDataContract({
        credential: { type: "api_key" },
        fields: [{ key: "api_key", name: "API key", value: "[redacted]", secret: true }],
      }),
    ).toThrowError(NodeWriteError);
  });

  it("does not stand in the way of a real write", () => {
    expect(() =>
      assertNodeDataContract({
        credential: { type: "api_key" },
        fields: [{ key: "api_key", name: "API key", value: "sk_live_new", secret: true }],
      }),
    ).not.toThrow();
    expect(() => assertNodeDataContract({ subtasks: [] })).not.toThrow();
    expect(() => assertNodeDataContract(null)).not.toThrow();
  });
});
