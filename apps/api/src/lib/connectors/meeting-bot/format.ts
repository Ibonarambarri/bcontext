/**
 * Tiny presentation helpers for the meeting-bot webhook → node mapping.
 * Kept separate so they're trivially unit-testable without
 * pulling the route + Supabase into the test runner.
 */

export function defaultMeetingTitle(at: string | null | undefined): string {
  const d = at ? new Date(at) : new Date();
  if (Number.isNaN(d.getTime())) return "Meeting";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `Meeting · ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function participantsLine(participants: string[]): string | undefined {
  if (participants.length === 0) return undefined;
  if (participants.length <= 6) return `Participants: ${participants.join(", ")}`;
  return `Participants: ${participants.slice(0, 6).join(", ")} + ${participants.length - 6} more`;
}
