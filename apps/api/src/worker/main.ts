/**
 * Worker entrypoint: the only queue runner.
 *
 * Same repository, same Docker image as the API and the error collector,
 * selected with `BCONTEXT_PROCESS=worker`:
 *
 *     node worker.js        # instead of `node api.js`
 *
 * There are no HTTP crons: every scheduled job is a pg-boss queue whose
 * cadence lives in `src/lib/queue/queues.ts`, versioned in the repo and
 * reconciled on boot (`docs/ops/worker.md`).
 *
 * HARD RULE: nothing in this file's import graph may touch `next/*`;
 * `build:worker` fails if anything does.
 */
import { log } from "@bcontext-dev/contract/log";
import {
  applySchedules,
  createBoss,
  registerQueues,
  registerWorkers,
} from "@/lib/queue/boss";
import { closePool } from "@/lib/queue/db";
import { QUEUES } from "@/lib/queue/queues";
import { flushReport, reportWorkerError, workerReporter } from "@/lib/errors/report";
import { assertAppUrlConfigured } from "@/lib/app-url";

// The two failures no job wrapper can see, because nothing caught them. The
// API entrypoint carries the identical pair for the identical reason; they are
// deliberately the same two lines in both processes so that "the worker died"
// and "the API died" read the same way in the panel, told apart by `service`.
//
// A rejected promise nobody awaited would otherwise end this process on Node's
// default, taking a half-drained batch with it. An uncaught exception does end
// it: state is unknowable and the container restart policy is the correct repair — but
// the report has to leave first, hence the bounded flush.
process.on("unhandledRejection", (reason) => {
  log.error("worker.unhandled_rejection", {
    error: { message: reason instanceof Error ? reason.message : String(reason) },
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  reportWorkerError({
    operation: "process:unhandled_rejection",
    level: "error",
    error: reason,
  });
});
process.on("uncaughtException", (err: Error) => {
  log.error("worker.uncaught_exception", { error: { message: err.message }, stack: err.stack });
  void flushReport(workerReporter(), {
    operation: "process:uncaught_exception",
    level: "fatal",
    error: err,
  }).finally(() => {
    process.exit(1);
  });
});

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    log.error("worker.boot.missing_database_url", {});
    process.exit(1);
  }
  // Digests and escalations mail links into the web app; without its URL
  // they would point nowhere.
  try {
    assertAppUrlConfigured();
  } catch (err) {
    log.error("worker.boot.missing_app_url", { error: { message: (err as Error).message } });
    process.exit(1);
  }

  const boss = createBoss("worker");
  boss.on("error", (err: unknown) => {
    log.error("worker.boss.error", {
      error: { message: err instanceof Error ? err.message : String(err) },
    });
  });

  await boss.start();
  await registerQueues(boss);
  const schedules = await applySchedules(boss);
  const workers = await registerWorkers(boss);

  log.info("worker.boot.ready", {
    queues: QUEUES.map((q) => q.name),
    scheduled: schedules.scheduled,
    unscheduled: schedules.removed,
    workers: workers.length,
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("worker.shutdown.begin", { signal });
    try {
      // Graceful: let in-flight batches finish rather than orphaning rows in
      // 'running' for the CAS lock's expiry to clean up. `stop()` resolves
      // immediately; the `stopped` event is what says the drain is over.
      await new Promise<void>((resolve) => {
        const done = setTimeout(resolve, 35_000);
        boss.once("stopped", () => {
          clearTimeout(done);
          resolve();
        });
        void boss.stop({ graceful: true, timeout: 30_000 });
      });
      await closePool();
    } catch (err) {
      log.error("worker.shutdown.failed", {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
    log.info("worker.shutdown.done", { signal });
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  log.error("worker.boot.failed", {
    error: { message: err instanceof Error ? err.message : String(err) },
  });
  // A worker that cannot boot is invisible otherwise: it never processes a
  // job, so no job ever fails, and the only symptom is queues quietly growing.
  void flushReport(workerReporter(), {
    operation: "process:boot",
    level: "fatal",
    error: err,
  }).finally(() => {
    process.exit(1);
  });
});
