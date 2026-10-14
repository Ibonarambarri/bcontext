/**
 * Retention for the error tables — the job that keeps a debugging aid from
 * becoming a disk problem.
 *
 * It exists because the failure mode of a self-hosted collector is not the
 * collector, it is the growth. One endpoint erroring on every request writes
 * as many rows as it serves, and the day that happens is the day nobody is
 * looking at row counts. Two defences stand in front of this one — the
 * per-minute sampling cap inside `record_error_event` and the collector's own
 * token bucket — but both bound the RATE, and only this bounds the TOTAL.
 *
 * The policy, and why it is two numbers rather than one:
 *
 *   - Events older than `ERRORS_EVENT_RETENTION_DAYS` (30) go. A stack trace
 *     from last month has already been acted on or never will be; what
 *     survives it is the group, whose counters and dates keep the history
 *     that is actually re-read.
 *   - Groups go only when they are `ERRORS_GROUP_RETENTION_DAYS` (90) quiet,
 *     have no events left AND carry no note. The note is the test: it means
 *     a person wrote something down about this problem, and deleting somebody
 *     else's conclusion to save a row is the wrong trade at any scale this
 *     product will see.
 *
 * The work is one SQL function call (`purge_error_telemetry`), not a delete
 * issued from here: the predicate belongs next to the tables, and PostgREST
 * cannot express "delete the groups with no surviving children" in one trip.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@bcontext-dev/contract/log";

/** Long enough that a bug reported on a Friday is still there on Monday
 *  week, short enough that the table stays small on a small VPS. */
const DEFAULT_EVENT_DAYS = 30;
/** A group is cheap — one row — so it is kept three times longer than its
 *  occurrences, and the list stays honest about what has ever broken. */
const DEFAULT_GROUP_DAYS = 90;

export interface PurgeResult extends Record<string, unknown> {
  events_deleted: number;
  groups_deleted: number;
}

function days(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/**
 * Run the purge once. Returns what it deleted, which the worker logs — a
 * retention job whose output nobody can see is one that can quietly stop
 * running for a month.
 */
export async function purgeErrorTelemetry(
  client = getSupabaseAdmin(),
): Promise<PurgeResult> {
  const eventDays = days(process.env.ERRORS_EVENT_RETENTION_DAYS, DEFAULT_EVENT_DAYS);
  const groupDays = days(process.env.ERRORS_GROUP_RETENTION_DAYS, DEFAULT_GROUP_DAYS);

  const { data, error } = await client.rpc("purge_error_telemetry", {
    p_event_days: eventDays,
    p_group_days: groupDays,
  });

  if (error) {
    // Thrown, not swallowed: this is the one place in the error pipeline
    // where failing loudly is right. Everything else here runs inside
    // somebody's catch block and must not add a second failure; this runs as
    // a job, and a job that cannot purge should retry and then be seen.
    throw new Error(`purge_error_telemetry failed: ${error.message}`);
  }

  // The function returns a single row; PostgREST hands set-returning
  // functions back as an array.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { events_deleted?: number | string; groups_deleted?: number | string }
    | null
    | undefined;

  const result: PurgeResult = {
    events_deleted: Number(row?.events_deleted ?? 0),
    groups_deleted: Number(row?.groups_deleted ?? 0),
    event_days: eventDays,
    group_days: groupDays,
  };
  log.info("errors.retention.done", result);
  return result;
}
