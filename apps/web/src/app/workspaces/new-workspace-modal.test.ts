import { describe, expect, it } from "vitest";
import { apiErrorMessage } from "./new-workspace-modal";

/** What to say when the API refuses the workspace. */
describe("apiErrorMessage", () => {
  it("prefers the message the route wrote", () => {
    expect(
      apiErrorMessage(
        { error: "organization_required", message: "Say which organization the workspace belongs to." },
        400,
      ),
    ).toBe("Say which organization the workspace belongs to.");
  });

  it("reads a flattened validation error rather than showing the status", () => {
    expect(
      apiErrorMessage(
        { error: { formErrors: [], fieldErrors: { organization: ["Required"] } } },
        400,
      ),
    ).toBe("organization: Required");
  });

  it("falls back to the code when that is all there is", () => {
    expect(apiErrorMessage({ error: "organization_not_found" }, 404)).toBe(
      "organization_not_found",
    );
  });

  it("says something a person can read when the body says nothing", () => {
    expect(apiErrorMessage(null, 500)).toContain("HTTP 500");
    expect(apiErrorMessage("<html>", 502)).toContain("HTTP 502");
  });
});
