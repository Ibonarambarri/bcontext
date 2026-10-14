/**
 * This repo's two reporters, and the small amount of context this repo is in a
 * position to attach to a report.
 *
 * The emitter itself lives in the contract (`@bcontext-dev/contract/error-report`)
 * because four processes across three repos send to the same collector and the
 * wire format has to be agreed once. What cannot be agreed once is *who was
 * asking*: only this repo knows that a request carries a request-id in
 * AsyncLocalStorage, that a job carries an attempt number, that a principal is
 * a token rather than a person. That is what this module adds — nothing more.
 *
 * Two deliberate non-goals:
 *
 *   - It does not reach for the session. Resolving an actor costs a database
 *     round-trip in most of the places that would want it, and a catch block
 *     on the way to a 500 is the worst possible place to spend one. Callers
 *     that already hold the ids pass them; the rest send a report without
 *     them, which is still a report.
 *   - It does not validate. The collector does, and a reporter that rejects
 *     its own input turns a bug into two. The one exception is `actorFields`,
 *     which drops ids that are not UUIDs — the report schema types those
 *     columns as UUIDs, so a non-UUID there would cost the whole event rather
 *     than one field.
 *
 * The worker imports this, so its import graph must stay free of request-only
 * dependencies — `build:worker` checks that.
 */
import { createErrorReporter, type ReportInput, type Reporter } from "@bcontext-dev/contract/error-report";
import type { ErrorActorType } from "@bcontext-dev/contract/errors";
import { correlationId, requestId } from "@bcontext-dev/contract/correlation";

/** The two processes this image runs. Built at import time: `createErrorReporter`
 *  reads the environment once and is a no-op when the collector is unset, which
 *  is the case in every test and every local run. */
const apiReporterDefault: Reporter = createErrorReporter("api");
const workerReporterDefault: Reporter = createErrorReporter("worker");

let apiOverride: Reporter | null = null;

export function apiReporter(): Reporter {
  return apiOverride ?? apiReporterDefault;
}

export function workerReporter(): Reporter {
  return workerReporterDefault;
}

/**
 * Test seam, in the shape `setPoolForTests` established: the module keeps its
 * own singleton and a test swaps it for a spy. The alternative — threading a
 * reporter through `withRoute`'s signature — would put a telemetry argument in
 * front of every route author forever, to serve two tests.
 */
export function setApiReporterForTests(next: Reporter | null): void {
  apiOverride = next;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActorInput {
  actorType?: ErrorActorType;
  userId?: string | null;
  organizationId?: string | null;
  workspaceId?: string | null;
  /** The token's id. Never the token — see the redaction note in the contract. */
  tokenId?: string | null;
}

/**
 * The actor half of a report, with anything that is not a UUID dropped.
 *
 * Callers hand us whatever they happen to hold, and in this codebase a
 * "workspace" is sometimes a slug (`acme/product`) and sometimes a UUID. The
 * collector's schema only accepts the second, and it rejects the whole event
 * rather than the offending field, so filtering here is the difference between
 * a partial report and no report.
 */
export function actorFields(actor: ActorInput): Partial<ReportInput> {
  const out: Partial<ReportInput> = {};
  if (actor.actorType) out.actor_type = actor.actorType;
  if (actor.userId && UUID.test(actor.userId)) out.user_id = actor.userId;
  if (actor.organizationId && UUID.test(actor.organizationId)) {
    out.organization_id = actor.organizationId;
  }
  if (actor.workspaceId && UUID.test(actor.workspaceId)) out.workspace_id = actor.workspaceId;
  if (actor.tokenId) out.token_id = String(actor.tokenId).slice(0, 120);
  return out;
}

/**
 * The ids the ambient request context already knows, unless the caller set
 * them. This is what ties an error row to the `request.failed` log line and to
 * the rest of a multi-step agent run: without it the panel shows an exception
 * and nothing you can search the logs for.
 *
 * Outside a request (a job, a boot failure) the store is empty and both fields
 * are simply absent.
 */
function withCorrelation(input: ReportInput): ReportInput {
  const rid = input.request_id ?? requestId();
  const cid = input.correlation_id ?? correlationId();
  return {
    ...input,
    ...(rid ? { request_id: rid } : {}),
    ...(cid ? { correlation_id: cid } : {}),
  };
}

/**
 * Report from the API process. Fire-and-forget by construction, and wrapped
 * once more here: `withCorrelation` reads an AsyncLocalStorage store and
 * `actorFields` runs regexes, and neither is worth a second exception thrown
 * inside somebody's catch block.
 */
export function reportApiError(input: ReportInput): void {
  try {
    apiReporter()(withCorrelation(input));
  } catch {
    // Rule 1 of the contract's reporter, restated for the glue around it.
  }
}

/** The same, from the worker. */
export function reportWorkerError(input: ReportInput): void {
  try {
    workerReporter()(withCorrelation(input));
  } catch {
    // See above.
  }
}

/**
 * Send and wait, for a process that is about to exit and would otherwise take
 * the report with it. Bounded: a collector that is down must not be able to
 * hold a shutdown open, and an uncaught exception has already made this
 * process untrustworthy — the supervisor restarting it promptly matters more
 * than the report landing.
 */
export async function flushReport(
  reporter: Reporter,
  input: ReportInput,
  timeoutMs = 1_500,
): Promise<void> {
  try {
    await Promise.race([
      reporter.flush(withCorrelation(input)),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        // Do not let the timer itself keep the loop alive if the flush wins.
        if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
      }),
    ]);
  } catch {
    // Never throw on the way out.
  }
}
