/**
 * Enqueuing side of the queue runtime.
 *
 * The single reason this module exists rather than callers using
 * `boss.send()` directly: **`tx`**. pg-boss accepts a connection to write the
 * job row through (`send(name, data, { db })`), so passing the `Executor`
 * that `withTransaction` hands out puts the job insert in the *same*
 * transaction as the caller's own writes. Either both land or neither does —
 * the "committed the row, died before enqueuing" window disappears.
 */
import { log } from "@bcontext-dev/contract/log";
import { getBoss } from "./boss";
import { hasDatabaseUrl, type Executor } from "./db";

export interface EnqueueOptions {
  /** Transaction to write the job row through (see `withTransaction`). */
  tx?: Executor;
  /**
   * Collapse repeated nudges for the same target into one pending job.
   * Used by the webhook path so a burst of events queues one drain.
   */
  singletonKey?: string;
  singletonSeconds?: number;
  /** Delay before the job becomes available: seconds, ISO string or Date. */
  startAfter?: number | string | Date;
}

/**
 * Queue a job. Returns the job id, or `null` when the queue runtime is not
 * configured (no `DATABASE_URL`) — callers treat that as "the scheduled drain
 * will pick it up" and must not fail because of it.
 *
 * Errors are deliberately *not* swallowed when a `tx` is supplied: inside a
 * transaction a failed enqueue must roll the caller's write back, which is
 * the entire point.
 */
export async function enqueue(
  name: string,
  data: Record<string, unknown> = {},
  opts: EnqueueOptions = {},
): Promise<string | null> {
  if (!hasDatabaseUrl()) return null;
  const { tx, ...jobOpts } = opts;
  if (tx) {
    const boss = await getBoss();
    return boss.send(name, data, { ...jobOpts, db: tx });
  }
  try {
    const boss = await getBoss();
    return await boss.send(name, data, jobOpts);
  } catch (err) {
    log.warn("queue.enqueue_failed", {
      queue: name,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}
