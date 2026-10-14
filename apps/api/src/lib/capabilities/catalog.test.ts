import { describe, expect, it } from "vitest";
import { capabilityRef } from "./catalog";

describe("capabilityRef", () => {
  it("builds a stable, readable handle out of provider, capability key and tool name", () => {
    expect(capabilityRef("GitHub Cloud", "issues", "create.issue")).toBe("github_cloud/issues/create.issue");
  });

  it("keeps the tool name as the provider spells it, so it round-trips into the remote call", () => {
    expect(capabilityRef("linear", "issues", "linear_create_issue")).toBe("linear/issues/linear_create_issue");
  });
});
