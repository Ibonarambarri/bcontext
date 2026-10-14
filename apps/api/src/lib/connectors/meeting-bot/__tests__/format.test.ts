import { describe, expect, it } from "vitest";
import { defaultMeetingTitle, participantsLine } from "../format";

describe("defaultMeetingTitle", () => {
  it("renders a UTC-stable title from an ISO timestamp", () => {
    expect(defaultMeetingTitle("2026-06-12T10:30:00Z")).toBe(
      "Meeting · 2026-06-12 10:30",
    );
  });

  it("falls back to now() for null", () => {
    const out = defaultMeetingTitle(null);
    expect(out.startsWith("Meeting · ")).toBe(true);
  });

  it("falls back to a literal for an unparseable timestamp", () => {
    expect(defaultMeetingTitle("not a date")).toBe("Meeting");
  });
});

describe("participantsLine", () => {
  it("returns undefined for an empty list", () => {
    expect(participantsLine([])).toBeUndefined();
  });

  it("lists all names when under the cap", () => {
    expect(participantsLine(["Alice", "Bob", "Carol"])).toBe(
      "Participants: Alice, Bob, Carol",
    );
  });

  it("collapses overflow past 6 names", () => {
    const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
    expect(participantsLine(names)).toBe(
      "Participants: A, B, C, D, E, F + 2 more",
    );
  });
});
