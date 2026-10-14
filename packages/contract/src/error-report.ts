/**
 * The reporter: one function every process calls when something broke.
 *
 * Three rules, and they are the whole design.
 *
 *   1. It never throws. A reporter that can fail turns one bug into two, and
 *      the second one happens inside the error handler where nothing is
 *      catching. Every path here ends in a swallowed promise.
 *   2. It never blocks. Nothing awaits it: the caller is usually a catch
 *      block on the way to returning a 500, and a request that takes two
 *      extra seconds to fail is worse than an error nobody recorded.
 *   3. It is a no-op when unconfigured. Local development, tests and the
 *      landing page have no collector, and they should not need one to run.
 *
 * Where it sends: `ERRORS_INGEST_URL`, authenticated with
 * `ERRORS_INGEST_KEY`. Both unset means off.
 */
import type { ErrorReport, ErrorService } from "./errors.js";
import { ERROR_MESSAGE_MAX, ERROR_STACK_MAX } from "./errors.js";

/** Long enough for a healthy collector on the same VPS, short enough that a
 *  sick one cannot hold a shutdown open. */
const TIMEOUT_MS = 2_000;

/** Field names whose values never leave the process, wherever they appear in
 *  `context`. The check is on the KEY: values are unknowable, keys are how
 *  people label secrets, and one accidental `{ token }` spread into a context
 *  object would otherwise put a live credential in a table the whole panel
 *  reads. */
const SECRET_KEY = /(token|key|secret|password|authorization|cookie|credential|api[-_]?key)/i;
const REDACTED = "[redacted]";

export interface ReporterConfig {
  url?: string;
  key?: string;
  service: ErrorService;
  release?: string;
  environment?: string;
  instance?: string;
}

/** What a caller actually passes: the error, plus where it happened. */
export interface ReportInput extends Partial<Omit<ErrorReport, "service" | "message">> {
  operation: string;
  /** The thrown value, whatever it turned out to be. */
  error: unknown;
}

function envConfig(service: ErrorService): ReporterConfig {
  const env = typeof process !== "undefined" ? process.env : ({} as Record<string, string | undefined>);
  return {
    url: env.ERRORS_INGEST_URL || undefined,
    key: env.ERRORS_INGEST_KEY || undefined,
    service,
    // SOURCE_COMMIT is the image's build arg; the fallbacks are what other platforms
    // this ran on called it, kept because a build without a release is a
    // group nobody can date.
    release: env.RELEASE_SHA || env.SOURCE_COMMIT || env.GIT_COMMIT_SHA || undefined,
    environment: env.NODE_ENV || undefined,
    instance: env.HOSTNAME || undefined,
  };
}

/** Everything a thrown value can be, flattened to the three fields the table
 *  keeps. Not every throw is an Error — a rejected fetch, a string, a POJO
 *  from a library — and the ones that are not are exactly the ones worth
 *  recording carefully. */
export function describeError(error: unknown): {
  error_type: string | undefined;
  message: string;
  stack: string | undefined;
  cause: string | undefined;
} {
  if (error instanceof Error) {
    return {
      error_type: error.name || error.constructor?.name || "Error",
      message: clamp(error.message || String(error), ERROR_MESSAGE_MAX),
      stack: error.stack ? clamp(error.stack, ERROR_STACK_MAX) : undefined,
      cause: error.cause === undefined ? undefined : clamp(describeCause(error.cause), ERROR_STACK_MAX),
    };
  }
  if (typeof error === "object" && error !== null) {
    return {
      error_type: error.constructor?.name ?? "Object",
      message: clamp(safeJson(error) ?? String(error), ERROR_MESSAGE_MAX),
      stack: undefined,
      cause: undefined,
    };
  }
  return {
    error_type: typeof error,
    message: clamp(String(error), ERROR_MESSAGE_MAX),
    stack: undefined,
    cause: undefined,
  };
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}${cause.stack ? `\n${cause.stack}` : ""}`;
  }
  return safeJson(cause) ?? String(cause);
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * `context`, with anything that looks like a credential taken out. Applied on
 * the way out rather than on the way in: the collector redacts too, and this
 * is the copy that stops the secret from crossing the network at all.
 */
export function redactContext(
  context: Record<string, unknown> | undefined,
  depth = 0,
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (SECRET_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value) && depth < 3) {
      out[key] = redactContext(value as Record<string, unknown>, depth + 1);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Turn a call into the body the collector accepts. Exported because the web
 *  app's forwarding route builds a report it did not itself catch. */
export function buildReport(config: ReporterConfig, input: ReportInput): ErrorReport {
  const { error, operation, context, ...rest } = input;
  const described = describeError(error);
  return {
    service: config.service,
    operation,
    level: "error",
    release: config.release,
    environment: config.environment,
    instance: config.instance,
    occurred_at: new Date().toISOString(),
    ...described,
    ...stripUndefined(rest),
    context: redactContext(context),
  } as ErrorReport;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export interface Reporter {
  (input: ReportInput): void;
  /** Whether anything is actually being sent. Tests and boot logs ask. */
  readonly enabled: boolean;
  /** Send now and wait — for a process that is about to exit and would
   *  otherwise take the report with it. Still never throws. */
  flush(input: ReportInput): Promise<void>;
}

/**
 * A reporter bound to one service. Built once per process at import time; the
 * config is read from the environment unless a caller overrides it, which is
 * what the tests do.
 */
export function createErrorReporter(
  service: ErrorService,
  overrides: Partial<ReporterConfig> = {},
): Reporter {
  const config = { ...envConfig(service), ...overrides, service };
  const enabled = Boolean(config.url && config.key);

  const send = async (input: ReportInput): Promise<void> => {
    if (!enabled) return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        await fetch(`${config.url!.replace(/\/$/, "")}/ingest`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.key}`,
          },
          body: JSON.stringify(buildReport(config, input)),
          // The collector's answer is 202 and carries nothing anybody acts
          // on; keeping the connection alive matters more than reading it.
          keepalive: true,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Rule 1. The collector being down is not an event this process is in
      // any position to report.
    }
  };

  const reporter = ((input: ReportInput) => {
    void send(input);
  }) as { (input: ReportInput): void; enabled: boolean; flush(input: ReportInput): Promise<void> };
  reporter.enabled = enabled;
  reporter.flush = send;
  return reporter as Reporter;
}
