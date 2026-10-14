import { describe, expect, it } from "vitest";
import { newestUpdatedAt } from "./newest-updated-at";

describe("newestUpdatedAt", () => {
  it("picks the latest timestamp regardless of order", () => {
    expect(newestUpdatedAt("2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z", "2026-09-02T00:00:00Z")).toBe("2026-09-03T00:00:00Z");
  });

  it("ignores missing values and returns undefined when nothing is known", () => {
    expect(newestUpdatedAt(null, undefined, "2026-09-01T00:00:00Z")).toBe("2026-09-01T00:00:00Z");
    expect(newestUpdatedAt(null, undefined)).toBeUndefined();
  });

  it("keeps an unparseable value only when nothing parseable competes", () => {
    expect(newestUpdatedAt("not-a-date")).toBe("not-a-date");
    expect(newestUpdatedAt("not-a-date", "2026-09-01T00:00:00Z")).toBe("2026-09-01T00:00:00Z");
  });
});
