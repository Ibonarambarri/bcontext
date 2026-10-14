/**
 * Entry point for the error collector: `node errors.js`, the third process in
 * the same image as the API and the worker, selected with
 * `BCONTEXT_PROCESS=errors`.
 *
 * It is its own process rather than a route on the API for one reason worth
 * the extra container: the API is the thing most likely to be broken when the
 * reports start arriving. A collector that shares a heap, an event loop and a
 * connection pool with the service it collects from is unavailable exactly
 * when it is needed, and — worse — its own failures arrive as reports it
 * cannot write. Separate process, separate pool, separate blast radius.
 *
 * Same rule as the worker and the API: nothing in this file's import graph may
 * touch `next/*`, and `build:errors` fails if anything does.
 */
import { serve } from "@hono/node-server";
import { log } from "@bcontext-dev/contract/log";
import { createErrorsApp } from "./app";
import { closeErrorsPool, hasDatabaseUrl } from "./store";

// Two configuration failures are worth dying for at boot, because both are
// silent at runtime: without a key the collector would accept anonymous
// writes into a table the admin panel reads, and without a connection string
// it would answer 202 to everything and store none of it. Crashing here is a
// red container in the orchestrator; the alternative is a collector that looks healthy
// and is not.
if (!process.env.ERRORS_INGEST_KEY) {
  log.error("errors.boot.missing_ingest_key", {});
  process.exit(1);
}
if (!hasDatabaseUrl()) {
  log.error("errors.boot.missing_database_url", {});
  process.exit(1);
}

// Neither handler reports anywhere: this IS the reporting endpoint, and a
// collector that tried to tell itself about its own crash would either
// deadlock or, on a bad day, loop. stderr is the only backstop it gets, which
// is why both lines carry the stack.
process.on("unhandledRejection", (reason) => {
  log.error("errors.unhandled_rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
process.on("uncaughtException", (err) => {
  log.error("errors.uncaught_exception", { error: err.message, stack: err.stack });
  process.exit(1);
});

const port = Number(process.env.ERRORS_PORT ?? 4100);
const app = createErrorsApp();

const server = serve({ fetch: app.fetch, port }, (info) => {
  log.info("errors.boot.ready", { port: info.port });
});

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log.info("errors.shutdown.begin", { signal });
    // Stop accepting first, then release the connections. In-flight reports
    // finish; anything that arrives after the socket closes is lost, which is
    // what a fire-and-forget reporter already expects on any given send.
    server.close(() => {
      void closeErrorsPool().finally(() => {
        log.info("errors.shutdown.done", { signal });
        process.exit(0);
      });
    });
  });
}
