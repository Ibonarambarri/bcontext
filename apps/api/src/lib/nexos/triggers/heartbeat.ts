/**
 * The Nexos' clock: every minute (`nexos.heartbeat`), find the Nexos whose
 * heartbeat is due, schedule their next beat and enqueue one `nexos.run`
 * (trigger `heartbeat`, the checklist as instruction) for each.
 *
 * Callers: the `nexos.heartbeat` job (`src/lib/queue/handlers.ts`).
 *
 * Must not break:
 *   - Beats only land inside the Nexo's active hours, read in its own IANA
 *     timezone (`Intl`), including windows that cross midnight. A beat that
 *     would fall outside moves to the next opening.
 *   - `next_heartbeat_at` moves under a compare-and-set before anything is
 *     enqueued: of two workers that read the same due row, only the one whose
 *     write lands fires. The run's singletonKey names the beat as well.
 *   - Paused Nexos never beat (the store scan only returns active ones); a
 *     Nexo whose heartbeat was switched off has its clock cleared.
 */
import type { NexoHeartbeat } from "@bcontext-dev/contract/nexos";
import { log } from "@bcontext-dev/contract/log";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import type { StorageBackend } from "@/lib/storage";
import { enqueue } from "@/lib/queue/producers";
import { QUEUE_NEXOS_RUN } from "@/lib/queue/queues";
import { listDueHeartbeats, listUnscheduledHeartbeats, setNextHeartbeat } from "../store";
import type { Nexo, NexoTarget } from "../types";

const DAY = 24 * 60;

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Minutes since local midnight of `at` in `tz`. An unknown timezone reads as UTC. */
export function localMinutes(at: Date, tz: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

/** Whether `at` falls inside the active hours. `start === end` means all day; `start > end` crosses midnight. */
export function isWithinActiveHours(hours: NexoHeartbeat["active_hours"], at: Date): boolean {
  const start = hhmmToMinutes(hours.start);
  const end = hhmmToMinutes(hours.end);
  if (start === end) return true;
  const local = localMinutes(at, hours.tz);
  return start < end ? local >= start && local < end : local >= start || local < end;
}

/** The first instant at or after `at` that is inside the active hours, to the minute. */
export function nextActiveInstant(hours: NexoHeartbeat["active_hours"], at: Date): Date {
  if (isWithinActiveHours(hours, at)) return at;
  const start = hhmmToMinutes(hours.start);
  const base = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  const delta = (start - localMinutes(base, hours.tz) + DAY) % DAY;
  let next = new Date(base.getTime() + delta * 60_000);
  // A DST jump between `at` and the opening shifts the wall clock by the
  // offset change; one correction lands on the local opening time.
  const drift = start - localMinutes(next, hours.tz);
  const fix = ((drift + DAY / 2) % DAY + DAY) % DAY - DAY / 2;
  if (fix !== 0) next = new Date(next.getTime() + fix * 60_000);
  return next;
}

/** When the beat after `from` is due, or null when the heartbeat is off. */
export function nextHeartbeatAt(hb: NexoHeartbeat, from: Date): Date | null {
  if (!hb.enabled || !Number.isFinite(hb.every_minutes) || hb.every_minutes <= 0) return null;
  return nextActiveInstant(hb.active_hours, new Date(from.getTime() + hb.every_minutes * 60_000));
}

/** Instruction handed to the runner on a heartbeat turn. */
export function heartbeatInstruction(nexo: Pick<Nexo, "heartbeat">): string {
  const checklist = nexo.heartbeat.checklist_md.trim();
  return checklist
    ? `Revisión periódica. Repasa esta lista y actúa solo si algo lo requiere; si no hay nada, responde NO_REPLY.\n\n${checklist}`
    : "Revisión periódica sin lista definida: comprueba si hay algo pendiente en tu ámbito; si no hay nada, responde NO_REPLY.";
}

export interface HeartbeatScanResult {
  due: number;
  enqueued: number;
  initialised: number;
  cleared: number;
  lost: number;
  outside_hours: number;
}

export async function scheduleDueHeartbeats(
  opts: { now?: Date; backend?: StorageBackend; enqueueRun?: typeof enqueue } = {},
): Promise<HeartbeatScanResult> {
  const now = opts.now ?? new Date();
  const send = opts.enqueueRun ?? enqueue;
  const result: HeartbeatScanResult = { due: 0, enqueued: 0, initialised: 0, cleared: 0, lost: 0, outside_hours: 0 };

  for (const nexo of await listUnscheduledHeartbeats({ backend: opts.backend })) {
    const t = targetOf(nexo, opts.backend);
    const next = nextHeartbeatAt(nexo.heartbeat, now);
    if (await setNextHeartbeat(t, nexo.id, next?.toISOString() ?? null, { expected: null })) result.initialised += 1;
  }

  const due = await listDueHeartbeats({ now, backend: opts.backend });
  result.due = due.length;
  for (const nexo of due) {
    const t = targetOf(nexo, opts.backend);
    const beat = nexo.next_heartbeat_at;
    const next = nextHeartbeatAt(nexo.heartbeat, now);
    const won = await setNextHeartbeat(t, nexo.id, next?.toISOString() ?? null, { expected: beat });
    if (!won) {
      result.lost += 1;
      continue;
    }
    if (!next) {
      result.cleared += 1;
      continue;
    }
    // A beat that came due while the worker was down may now be outside the
    // window; the clock already moved to the next opening, so just skip it.
    if (!isWithinActiveHours(nexo.heartbeat.active_hours, now)) {
      result.outside_hours += 1;
      continue;
    }
    await send(
      QUEUE_NEXOS_RUN,
      { nexo_id: nexo.id, workspace_id: nexo.workspace_id, trigger: "heartbeat", scheduled_for: beat },
      { singletonKey: `heartbeat:${nexo.id}:${beat}` },
    );
    result.enqueued += 1;
  }
  if (result.enqueued || result.initialised) log.info("nexos.heartbeat.scan", { ...result });
  return result;
}

function targetOf(nexo: Nexo, backend?: StorageBackend): NexoTarget {
  return { workspaceId: nexo.workspace_id, backend: backend ?? (isSupabaseConfigured() ? "supabase" : "demo") };
}
