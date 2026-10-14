/**
 * Format a diarized transcript into the Bcontext-flavored markdown body
 * used for `meeting` nodes.
 *
 * Layout: one block per contiguous run of segments from the same speaker.
 *
 *   **Alice** · 00:01
 *   Hey team, welcome. We're going to talk about Q3 priorities.
 *
 *   **Bob** · 00:18
 *   Sounds good — I have the deck ready.
 *
 * The compact `00:18` timestamp lets the reader scrub the recording.
 * Speaker labels come straight from the provider (often "Speaker 1, 2…"
 * if voiceprints aren't configured); a future task ties them to entity
 * nodes for known people.
 */
import type { TranscriptSegment } from "@bcontext-dev/contract/connectors/meeting-bot/provider";

interface FormatOptions {
  /** Title to put at the top of the document. Omitted = no h1. */
  title?: string;
  /** Optional summary line under the title. */
  subtitle?: string;
  /** Include per-block timestamps. Default true. */
  timestamps?: boolean;
}

export function transcriptToMarkdown(
  segments: TranscriptSegment[],
  opts: FormatOptions = {},
): string {
  const blocks: string[] = [];

  if (opts.title) {
    blocks.push(`# ${opts.title}`);
  }
  if (opts.subtitle) {
    blocks.push(`_${opts.subtitle}_`);
  }

  if (segments.length === 0) {
    blocks.push("_(empty transcript)_");
    return blocks.join("\n\n");
  }

  const showTs = opts.timestamps !== false;
  let currentSpeaker = "";
  let buffer: string[] = [];
  let blockStart = 0;

  const flush = () => {
    if (!currentSpeaker) return;
    const header = showTs
      ? `**${currentSpeaker}** · ${formatTimestamp(blockStart)}`
      : `**${currentSpeaker}**`;
    blocks.push(`${header}\n${buffer.join(" ").trim()}`);
    buffer = [];
  };

  for (const seg of segments) {
    const speaker = (seg.speaker ?? "Unknown").trim() || "Unknown";
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    if (speaker !== currentSpeaker) {
      flush();
      currentSpeaker = speaker;
      blockStart = Number.isFinite(seg.startSec) ? seg.startSec : 0;
    }
    buffer.push(text);
  }
  flush();

  return blocks.join("\n\n");
}

export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}
