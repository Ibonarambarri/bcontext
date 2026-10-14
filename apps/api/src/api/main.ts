/**
 * Entry point for the API process: `node api.js`, the default command of the
 * image the worker and the error collector also run from. Same rule as the
 * worker — nothing here may import `next/*`, and `build:api` fails if
 * anything in the graph does.
 */
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createApiApp } from "./app";
import { attachRealtime } from "./realtime/server";
import { startRealtimeListener } from "@/lib/realtime/listener";
import { hasDatabaseUrl } from "@/lib/queue/db";
import { log } from "@bcontext-dev/contract/log";
import { apiReporter, flushReport, reportApiError } from "@/lib/errors/report";
import { assertAppUrlConfigured } from "@/lib/app-url";

// A rejected promise nobody awaited must not end the process. Node's
// default is to exit; the first time it happened here was an audit row with
// an optional field unset, fired and forgotten by a tool handler — the API
// died mid-experiment with three agents connected. Log it with the stack
// and keep serving. A synchronous uncaught exception is different: state is
// unknowable, so log and exit non-zero for the supervisor to restart.
//
// Both also report. These two are the events the panel most needs and the
// ones a per-route wrapper structurally cannot see: nothing caught them, so
// no `operation` is derivable from a call site — hence the `process:` prefix,
// which says exactly that. The levels differ on purpose: an unhandled
// rejection is a bug the process survived, an uncaught exception is a bug
// plus an outage.
process.on("unhandledRejection", (reason) => {
  log.error("api.unhandled_rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  reportApiError({
    operation: "process:unhandled_rejection",
    level: "error",
    error: reason,
  });
});
process.on("uncaughtException", (err) => {
  log.error("api.uncaught_exception", { error: err.message, stack: err.stack });
  // The only place in the codebase that waits for a report: the process is
  // one statement from gone and a fire-and-forget send would go with it.
  // `flushReport` is bounded, so a collector that is itself down delays the
  // supervisor's restart by a second and a half, not indefinitely.
  void flushReport(apiReporter(), {
    operation: "process:uncaught_exception",
    level: "fatal",
    error: err,
  }).finally(() => {
    process.exit(1);
  });
});

// Invitations, OAuth redirects and discovery documents name the web app; in
// production there is no default to fall back on, so refuse to boot.
try {
  assertAppUrlConfigured();
} catch (err) {
  log.error("api.boot.missing_app_url", { error: (err as Error).message });
  process.exit(1);
}

const port = Number(process.env.API_PORT ?? 4000);
const app = createApiApp();

const server = serve({ fetch: app.fetch, port }, (info) => {
  log.info("api.boot.ready", { port: info.port, realtime: "/realtime" });
});
// WebSockets ride the same listener: the upgrade is an event this server
// already emits, and the hub they feed is what server-broadcast reaches for.
const realtime = attachRealtime(server as Server);
// With a database, events from the worker and from the other API instances
// arrive on the NOTIFY channel; without one, over `POST /realtime/broadcast`.
const listener = hasDatabaseUrl() ? startRealtimeListener(realtime.hub) : null;
if (!listener) log.info("api.realtime.listen.skipped", { reason: "DATABASE_URL not set" });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info("api.shutdown.begin", { signal, ...realtime.hub.stats() });
    void Promise.all([realtime.close(), listener?.stop()]).then(() => {
      server.close(() => {
        log.info("api.shutdown.done", { signal });
        process.exit(0);
      });
    });
  });
}
