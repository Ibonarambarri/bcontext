import { describe, expect, it } from "vitest";
import {
  formatTimestamp,
  transcriptToMarkdown,
} from "../transcript-to-markdown";
import type { TranscriptSegment } from "@bcontext-dev/contract/connectors/meeting-bot/provider";

describe("transcriptToMarkdown", () => {
  const segments: TranscriptSegment[] = [
    { speaker: "Alice", text: "Hey team,", startSec: 0, endSec: 1 },
    { speaker: "Alice", text: "welcome to Q3 planning.", startSec: 1, endSec: 4 },
    { speaker: "Bob", text: "Got the deck ready.", startSec: 18, endSec: 21 },
    { speaker: "Bob", text: "Let me share.", startSec: 21, endSec: 23 },
    { speaker: "Alice", text: "Go for it.", startSec: 24, endSec: 25 },
  ];

  it("groups contiguous same-speaker segments into one block", () => {
    const md = transcriptToMarkdown(segments, { timestamps: false });
    const blocks = md.split("\n\n");
    expect(blocks).toEqual([
      "**Alice**\nHey team, welcome to Q3 planning.",
      "**Bob**\nGot the deck ready. Let me share.",
      "**Alice**\nGo for it.",
    ]);
  });

  it("renders compact timestamps when enabled", () => {
    const md = transcriptToMarkdown(segments, { timestamps: true });
    expect(md).toContain("**Alice** · 00:00");
    expect(md).toContain("**Bob** · 00:18");
    expect(md).toContain("**Alice** · 00:24");
  });

  it("includes title and subtitle when provided", () => {
    const md = transcriptToMarkdown(segments, {
      title: "Q3 kickoff",
      subtitle: "Participants: Alice, Bob",
    });
    expect(md.startsWith("# Q3 kickoff\n\n_Participants: Alice, Bob_\n\n")).toBe(true);
  });

  it("handles empty transcripts gracefully", () => {
    const md = transcriptToMarkdown([], { title: "Empty call" });
    expect(md).toBe("# Empty call\n\n_(empty transcript)_");
  });

  it("falls back to Unknown for missing speakers", () => {
    const md = transcriptToMarkdown(
      [{ speaker: "", text: "muttered", startSec: 0, endSec: 1 }],
      { timestamps: false },
    );
    expect(md).toBe("**Unknown**\nmuttered");
  });

  it("skips segments with empty text", () => {
    const md = transcriptToMarkdown(
      [
        { speaker: "Alice", text: "", startSec: 0, endSec: 1 },
        { speaker: "Alice", text: "real text", startSec: 1, endSec: 2 },
      ],
      { timestamps: false },
    );
    expect(md).toBe("**Alice**\nreal text");
  });
});

describe("formatTimestamp", () => {
  it("renders mm:ss under an hour", () => {
    expect(formatTimestamp(0)).toBe("00:00");
    expect(formatTimestamp(7)).toBe("00:07");
    expect(formatTimestamp(90)).toBe("01:30");
    expect(formatTimestamp(3599)).toBe("59:59");
  });

  it("renders h:mm:ss past an hour", () => {
    expect(formatTimestamp(3600)).toBe("1:00:00");
    expect(formatTimestamp(3725)).toBe("1:02:05");
  });

  it("clamps negative inputs to zero", () => {
    expect(formatTimestamp(-5)).toBe("00:00");
  });
});
