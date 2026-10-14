/**
 * The catalogue is the instance's schedule, versioned with the code, so it
 * gets asserted like configuration, not like code.
 */
import { describe, expect, it } from "vitest";
import {
  QUEUES,
  QUEUE_TASKS_AUTO_ARCHIVE,
  QUEUE_CAPABILITY_HEALTH,
  QUEUE_CAPABILITY_OAUTH_EXPIRE,
  QUEUE_CONNECTOR_DRAIN,
  QUEUE_CONNECTOR_SCHEDULE,
  QUEUE_ERRORS_RETENTION,
  QUEUE_NEXO_CONTRADICTIONS,
  QUEUE_NEXOS_FLUSH_WINDOWS,
  QUEUE_NEXOS_HEARTBEAT,
  QUEUE_NEXOS_RUN,
  QUEUE_SKILLS_RUN_SCHEDULED,
  QUEUE_SKILLS_SCHEDULE,
  QUEUE_WEBHOOK_DRAIN,
  queueByName,
} from "./queues";

/** The per-minute drains. They are the ones
 *  the cadence assertion is about; anything else here is maintenance and
 *  keeps its own clock. */
const DRAINS = [
  QUEUE_CAPABILITY_HEALTH,
  QUEUE_CONNECTOR_DRAIN,
  QUEUE_CONNECTOR_SCHEDULE,
  QUEUE_WEBHOOK_DRAIN,
];

describe("queue catalogue", () => {
  it("declares the drains the cron routes used to run (plus the cadence scheduler), plus maintenance", () => {
    expect(QUEUES.map((q) => q.name).sort()).toEqual(
      [...DRAINS, QUEUE_CAPABILITY_OAUTH_EXPIRE, QUEUE_ERRORS_RETENTION, QUEUE_TASKS_AUTO_ARCHIVE, QUEUE_NEXO_CONTRADICTIONS, QUEUE_SKILLS_SCHEDULE, QUEUE_SKILLS_RUN_SCHEDULED, QUEUE_NEXOS_HEARTBEAT, QUEUE_NEXOS_RUN, QUEUE_NEXOS_FLUSH_WINDOWS].sort(),
    );
  });

  it("keeps the production cadence for the drains: every minute", () => {
    for (const name of DRAINS) expect(queueByName(name)?.cron).toBe("* * * * *");
  });

  // Not a drain and deliberately not on the drains' clock: the predicate is
  // "older than N days", so a missed tick costs a day of extra rows and
  // running it every minute would only take the same locks 1,439 times for
  // nothing.
  // The pg_cron job it replaced ran every five minutes; an abandoned flow's
  // tokens should not sit in Vault much longer than its expiry.
  it("expires abandoned OAuth attempts every five minutes", () => {
    expect(queueByName(QUEUE_CAPABILITY_OAUTH_EXPIRE)?.cron).toBe("*/5 * * * *");
  });

  it("runs the retention purge once a day, off the round hours", () => {
    expect(queueByName(QUEUE_ERRORS_RETENTION)?.cron).toBe("20 4 * * *");
  });

  // Daily like the housekeeping jobs, and also fired on demand per node; the
  // model calls are what cost, so the cadence is not the cost control.
  it("runs the contradiction sweep once a day, after the housekeeping jobs", () => {
    expect(queueByName(QUEUE_NEXO_CONTRADICTIONS)?.cron).toBe("0 5 * * *");
  });

  // The skill clock ticks every five minutes — a digest due at 09:00 is out
  // by 09:05 — and the run it enqueues has no cron of its own: it exists only
  // as a job carrying a schedule id.
  it("ticks the skill scheduler every five minutes and keeps the run on demand", () => {
    expect(queueByName(QUEUE_SKILLS_SCHEDULE)?.cron).toBe("*/5 * * * *");
    expect(queueByName(QUEUE_SKILLS_RUN_SCHEDULED)?.cron).toBeNull();
  });

  // Nexos: two clocks on the drains' minute and the turn they enqueue, which
  // is on demand and keyed (stately) so a burst collapses into one turn.
  it("ticks the Nexo clocks every minute and keeps the turn on demand and keyed", () => {
    expect(queueByName(QUEUE_NEXOS_HEARTBEAT)?.cron).toBe("* * * * *");
    expect(queueByName(QUEUE_NEXOS_FLUSH_WINDOWS)?.cron).toBe("* * * * *");
    expect(queueByName(QUEUE_NEXOS_RUN)?.cron).toBeNull();
    expect(queueByName(QUEUE_NEXOS_RUN)?.options.policy).toBe("stately");
  });

  it("gives every queue a retry budget with backoff", () => {
    for (const q of QUEUES) {
      expect(q.options.retryLimit).toBeGreaterThan(0);
      expect(q.options.retryBackoff).toBe(true);
      expect(q.options.expireInSeconds).toBeGreaterThanOrEqual(300);
    }
  });

  it("has unique names and resolves them", () => {
    expect(new Set(QUEUES.map((q) => q.name)).size).toBe(QUEUES.length);
    expect(queueByName(QUEUE_WEBHOOK_DRAIN)?.cron).toBe("* * * * *");
    expect(queueByName("nope")).toBeUndefined();
  });
});
