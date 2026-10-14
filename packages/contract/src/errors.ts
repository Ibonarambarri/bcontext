/**
 * Error telemetry — the wire between whatever broke and the panel where it is
 * read.
 *
 * Four processes report here (the API, the worker, the web app and the
 * browser it serves) and one screen reads it, so the shape has to be agreed
 * once rather than four times. That is what this module is: the report a
 * reporter sends, the vocabularies both ends select on, and the rows the
 * admin list is made of.
 *
 * Two ideas carry the whole design:
 *
 *   - `operation` is WHERE. Not "the api" — `mcp.tool:nodes_write`,
 *     `rest:POST /api/nodes`, `job:webhook.drain`, `web.route:/w/[org]/[ws]`.
 *     "Which service" is one of four answers and never told anybody
 *     anything; the operation is what an operator filters on and what a fix
 *     is scoped to.
 *   - `fingerprint` is WHICH PROBLEM. Four thousand events are twelve
 *     problems, and a list of events is unreadable by the second day. The
 *     collector derives it (never the reporter — a client that chooses its
 *     own grouping key can split one problem into a thousand), and every
 *     event with the same one folds into a single group row.
 *
 * Nothing here imports anything: the browser bundles it too.
 */
import { z } from "zod";

/** Which process produced the error. Coarse on purpose — `operation` is the
 *  specific answer, and this is only the first cut of the filter bar. */
export const ERROR_SERVICES = ["api", "worker", "web", "browser", "landing"] as const;
export type ErrorService = (typeof ERROR_SERVICES)[number];

/** What each one is, for the one screen that shows them. The panel never
 *  renders a vocabulary raw — `ADMIN_ORG_STATE_LABELS` is the same idea for
 *  the organizations screen. */
export const ERROR_SERVICE_LABELS: Record<ErrorService, string> = {
  api: "API",
  worker: "Worker",
  web: "Web",
  browser: "Browser",
  landing: "Landing",
};

/**
 * How bad. `fatal` is reserved for what took the process with it (an uncaught
 * exception), which is a different thing from a request that returned 500 —
 * the second is a bug, the first is a bug plus an outage.
 */
export const ERROR_LEVELS = ["warning", "error", "fatal"] as const;
export type ErrorLevel = (typeof ERROR_LEVELS)[number];

export const ERROR_LEVEL_LABELS: Record<ErrorLevel, string> = {
  warning: "Warning",
  error: "Error",
  fatal: "Fatal",
};

/**
 * Triage, on the group and never on the event: an operator resolves a
 * problem, not one of its four thousand occurrences.
 *
 * `ignored` exists so that "known, not worth fixing" stops competing for
 * attention with "new and unread" without anybody having to lie and call it
 * resolved. A resolved group that fires again reopens itself — see the
 * collector — because a fix that did not hold is exactly the thing a list of
 * resolved problems must not hide.
 */
export const ERROR_STATUSES = ["new", "ack", "resolved", "ignored"] as const;
export type ErrorStatus = (typeof ERROR_STATUSES)[number];

/** `ack` is the one that needs saying in full: it is the only value here
 *  whose short form is jargon, and a control reading "ack" asks the operator
 *  to remember what the database calls things. */
export const ERROR_STATUS_LABELS: Record<ErrorStatus, string> = {
  new: "New",
  ack: "Acknowledged",
  resolved: "Resolved",
  ignored: "Ignored",
};

/** Who the request was being served for. `agent_token` and `user` are the two
 *  that matter: the same bug reached by an agent and by a person is two
 *  different urgencies. */
export const ERROR_ACTOR_TYPES = ["user", "agent_token", "cron", "system", "anon"] as const;
export type ErrorActorType = (typeof ERROR_ACTOR_TYPES)[number];

/** The report body's ceiling. A stack is a few kilobytes; anything past this
 *  is a payload somebody attached, and the collector truncates rather than
 *  refusing — a rejected error report is an error nobody ever sees. */
export const ERROR_MESSAGE_MAX = 2_000;
export const ERROR_STACK_MAX = 20_000;
export const ERROR_CONTEXT_MAX = 8_000;

/**
 * What a reporter sends. Everything but `service`, `operation` and `message`
 * is optional: the value of this pipeline is that instrumenting a new place
 * costs one line, and a schema that demands nine fields is a schema people
 * work around with a try/catch that swallows.
 */
export const ErrorReportSchema = z.object({
  service: z.enum(ERROR_SERVICES),
  /** The logical site. See the module note — this is the field that earns
   *  the whole table. */
  operation: z.string().trim().min(1).max(200),
  level: z.enum(ERROR_LEVELS).default("error"),

  /** `err.name` / constructor name. Half of the fingerprint. */
  error_type: z.string().trim().max(200).optional(),
  message: z.string().trim().min(1).max(ERROR_MESSAGE_MAX),
  stack: z.string().max(ERROR_STACK_MAX).optional(),
  /** `err.cause`, already flattened to text by the reporter — the collector
   *  is not going to walk an object graph a client controls. */
  cause: z.string().max(ERROR_STACK_MAX).optional(),

  /** When it happened where it happened. The collector records its own
   *  arrival time separately; the two always diverge and the difference is
   *  itself a symptom (a queue backing up, a browser reporting on next load). */
  occurred_at: z.string().datetime({ offset: true }).optional(),

  /** Which build. Without this nobody can say "this started yesterday". */
  release: z.string().trim().max(80).optional(),
  environment: z.string().trim().max(40).optional(),
  /** Container / host, for the day one replica is the sick one. */
  instance: z.string().trim().max(120).optional(),

  user_id: z.string().uuid().optional(),
  organization_id: z.string().uuid().optional(),
  workspace_id: z.string().uuid().optional(),
  actor_type: z.enum(ERROR_ACTOR_TYPES).optional(),
  /** The token's id. Never the token. */
  token_id: z.string().trim().max(120).optional(),

  /** Ties the row to the log line and to the trace across processes. */
  request_id: z.string().trim().max(120).optional(),
  correlation_id: z.string().trim().max(120).optional(),
  method: z.string().trim().max(10).optional(),
  path: z.string().trim().max(500).optional(),
  status_code: z.number().int().min(100).max(599).optional(),
  duration_ms: z.number().int().min(0).max(3_600_000).optional(),
  user_agent: z.string().trim().max(500).optional(),
  /** Where the browser was. Only the browser sends it. */
  url: z.string().trim().max(1_000).optional(),

  /** Worker only. */
  job_id: z.string().trim().max(120).optional(),
  job_name: z.string().trim().max(120).optional(),
  attempt: z.number().int().min(0).max(1_000).optional(),

  /** Anything else worth having when you open the row: a node id, a
   *  connector, a model. Redacted and size-capped by the collector — never
   *  put a request body in here. */
  context: z.record(z.unknown()).optional(),
});

export type ErrorReport = z.infer<typeof ErrorReportSchema>;

/** A batch is the same thing, n at a time: the browser reports on unload and
 *  the worker can have failed twenty jobs in a tick. Capped so one caller
 *  cannot hand the collector a megabyte. */
export const ERROR_BATCH_MAX = 50;
export const ErrorReportBatchSchema = z.object({
  events: z.array(ErrorReportSchema).min(1).max(ERROR_BATCH_MAX),
});

// ============================================================
// What the admin panel reads
// ============================================================

/** One problem, however many times it happened. */
export interface AdminErrorGroup {
  id: string;
  fingerprint: string;
  service: ErrorService;
  operation: string;
  level: ErrorLevel;
  error_type: string | null;
  /** The message of the most recent event, which is the one an operator
   *  reads first. Messages within a group differ in their variable parts. */
  message: string;
  status: ErrorStatus;
  first_seen: string;
  last_seen: string;
  event_count: number;
  users_affected: number;
  /** The build the group was first and last seen on: equal means it has not
   *  survived a deploy yet. */
  first_release: string | null;
  last_release: string | null;
  resolved_at: string | null;
  resolved_release: string | null;
  note: string | null;
}

/** One occurrence, as the detail screen lists them. */
export interface AdminErrorEvent {
  id: string;
  received_at: string;
  occurred_at: string | null;
  service: ErrorService;
  operation: string;
  level: ErrorLevel;
  error_type: string | null;
  message: string;
  stack: string | null;
  cause: string | null;
  release: string | null;
  environment: string | null;
  instance: string | null;
  user_id: string | null;
  organization_id: string | null;
  workspace_id: string | null;
  actor_type: ErrorActorType | null;
  token_id: string | null;
  request_id: string | null;
  correlation_id: string | null;
  method: string | null;
  path: string | null;
  status_code: number | null;
  duration_ms: number | null;
  user_agent: string | null;
  url: string | null;
  job_id: string | null;
  job_name: string | null;
  attempt: number | null;
  context: Record<string, unknown> | null;
}

export interface AdminErrorGroupDetail extends AdminErrorGroup {
  /** The most recent occurrences, newest first. Not all of them: a group can
   *  have fifty thousand and the screen answers "what does this look like",
   *  which the last twenty answer as well as all of them. */
  events: AdminErrorEvent[];
  /** Distinct people this group reached, named, capped at a handful. */
  users: Array<{ id: string; email: string | null; count: number }>;
}

export interface AdminErrorPage {
  items: AdminErrorGroup[];
  total: number;
  limit: number;
  offset: number;
  /** The filter bar's own vocabulary, computed over the whole set rather
   *  than the page: a service with no rows should not be offerable. */
  facets: {
    services: Array<{ id: string; count: number }>;
    statuses: Array<{ id: ErrorStatus; count: number }>;
  };
  /** Events (not groups) recorded in the last 24h, for the one number the
   *  screen shows above the table. */
  events24h: number;
}

/** The narrowings the list accepts. Everything is optional; a bare call is
 *  "everything unresolved, worst last-seen first". */
export interface AdminErrorListQuery {
  q?: string;
  service?: ErrorService;
  status?: ErrorStatus;
  level?: ErrorLevel;
  limit?: number;
  offset?: number;
}

/** How a group is ordered by default: what is still open, most recent first.
 *  An operator opens this screen to ask "what is broken now". */
export const ADMIN_ERROR_DEFAULT_STATUSES: readonly ErrorStatus[] = ["new", "ack"];
