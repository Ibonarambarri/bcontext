/**
 * The error telemetry, as the platform admin reads it.
 *
 * `0074_error_telemetry.sql` writes two tables and this file is the only
 * thing that reads them: a page of problems for the list, one problem with
 * its occurrences for the detail, and the two fields an operator owns —
 * `status` and `note`. Everything runs on the service-role client, so every
 * caller must have gone through `gateAdmin` first; nothing here is reachable
 * with a user's own key, and the tables have RLS on with no policies so they
 * fail closed if anybody ever tries.
 *
 * THE DECISION THIS SCREEN IS BUILT ON: with no `status` asked for, the list
 * shows only `ADMIN_ERROR_DEFAULT_STATUSES` — what is still open. An
 * operator opens this screen to ask "what is broken now", and a list whose
 * first page is three months of resolved problems does not answer it. The
 * resolved and the ignored are one click away (`?status=resolved`) and the
 * status facet counts them even while they are hidden, so nothing is
 * concealed — it is a default, not a filter you cannot undo. It is also why
 * the reopen rule in `record_error_event` matters: a resolved group that
 * fires again becomes `new` and walks back into this default view by itself.
 *
 * THE OTHER THING TO KNOW, because it decides how every number here reads:
 * `error_events` is SAMPLED (at most `sample_cap` rows per group and minute)
 * while `error_groups.event_count` counts every occurrence. So counts taken
 * off the group are true and counts taken off the events are floors. Where
 * this file has to use the events — the per-user tallies on the detail — it
 * says so.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@bcontext-dev/contract/log";
import { pageBounds, searchTerm } from "@/lib/admin/list-params";
import {
  ADMIN_ERROR_DEFAULT_STATUSES,
  ERROR_STATUSES,
  type AdminErrorEvent,
  type AdminErrorGroup,
  type AdminErrorGroupDetail,
  type AdminErrorListQuery,
  type AdminErrorPage,
  type ErrorActorType,
  type ErrorLevel,
  type ErrorService,
  type ErrorStatus,
} from "@bcontext-dev/contract/errors";

/**
 * Same shape as `AdminOrgError`, and for the same reason: the routes map one
 * exception class onto a status code, and everything else is a 500 that
 * deserves to be one.
 */
export class AdminErrorError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AdminErrorError";
  }
}

const GROUP_COLUMNS =
  "id, fingerprint, service, operation, level, error_type, message, status, " +
  "first_seen, last_seen, event_count, users_affected, first_release, " +
  "last_release, resolved_at, resolved_release, note";

const EVENT_COLUMNS =
  "id, received_at, occurred_at, service, operation, level, error_type, " +
  "message, stack, cause, release, environment, instance, user_id, " +
  "organization_id, workspace_id, actor_type, token_id, request_id, " +
  "correlation_id, method, path, status_code, duration_ms, user_agent, url, " +
  "job_id, job_name, attempt, context";

/**
 * How many occurrences the detail screen lists. The question it answers is
 * "what does this look like", and the twenty most recent answer it as well
 * as fifty thousand would — see the contract's note on `events`.
 */
const GROUP_EVENT_LIMIT = 20;

/**
 * How many of a group's stored events are read to tally who it reached. The
 * array on the group is capped at 50 people and sampling bounds the rows, so
 * this is a ceiling that should never be met; it is here so that one
 * pathological group cannot make the detail screen page through a month.
 */
const GROUP_USER_EVENT_SCAN = 1_000;

/**
 * How many group rows the facet counts sweep. Past this the counts under the
 * filter bar become approximate — which is survivable, since a facet is a
 * hint about where to click — and the numbers on the rows themselves, which
 * are not, all come off the group.
 */
const FACET_SCAN_MAX = 5_000;

interface GroupRow {
  id: string;
  fingerprint: string;
  service: string;
  operation: string;
  level: string;
  error_type: string | null;
  message: string;
  status: string;
  first_seen: string;
  last_seen: string;
  event_count: number | null;
  users_affected: number | null;
  first_release: string | null;
  last_release: string | null;
  resolved_at: string | null;
  resolved_release: string | null;
  note: string | null;
}

/**
 * The row as the panel reads it. `service`, `level` and `status` are cast
 * rather than validated: the columns carry check constraints listing exactly
 * the contract's vocabularies, so a value outside them is a migration that
 * went out without its contract change — a bug to fix, not a case to hide.
 */
function toAdminErrorGroup(row: GroupRow): AdminErrorGroup {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    service: row.service as ErrorService,
    operation: row.operation,
    level: row.level as ErrorLevel,
    error_type: row.error_type,
    message: row.message,
    status: row.status as ErrorStatus,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    // Every occurrence, sampled ones included. Never `events.length`.
    event_count: Number(row.event_count ?? 0),
    users_affected: Number(row.users_affected ?? 0),
    first_release: row.first_release,
    last_release: row.last_release,
    resolved_at: row.resolved_at,
    resolved_release: row.resolved_release,
    note: row.note,
  };
}

interface EventRow extends Record<string, unknown> {
  id: string;
  received_at: string;
}

function toAdminErrorEvent(row: EventRow): AdminErrorEvent {
  const str = (k: string): string | null => (row[k] as string | null) ?? null;
  const num = (k: string): number | null => {
    const v = row[k];
    return v === null || v === undefined ? null : Number(v);
  };
  return {
    id: row.id,
    received_at: row.received_at,
    occurred_at: str("occurred_at"),
    service: (row.service as ErrorService) ?? "api",
    operation: (row.operation as string) ?? "unknown",
    level: (row.level as ErrorLevel) ?? "error",
    error_type: str("error_type"),
    message: (row.message as string) ?? "",
    stack: str("stack"),
    cause: str("cause"),
    release: str("release"),
    environment: str("environment"),
    instance: str("instance"),
    user_id: str("user_id"),
    organization_id: str("organization_id"),
    workspace_id: str("workspace_id"),
    actor_type: (row.actor_type as ErrorActorType | null) ?? null,
    token_id: str("token_id"),
    request_id: str("request_id"),
    correlation_id: str("correlation_id"),
    method: str("method"),
    path: str("path"),
    status_code: num("status_code"),
    duration_ms: num("duration_ms"),
    user_agent: str("user_agent"),
    url: str("url"),
    job_id: str("job_id"),
    job_name: str("job_name"),
    attempt: num("attempt"),
    context: (row.context as Record<string, unknown> | null) ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A page of problems, most recently seen first.
 *
 * THE SHAPE OF THE READ, in three queries and no per-row work:
 *
 *   the page itself — the filters, `order by last_seen desc` on the index the
 *   migration created for exactly this, and a `range`. `total` is Postgres's
 *   own exact count of what the filters left, never the length of the page.
 *
 *   one sweep of `(service, status)` over the same set MINUS the two
 *   facetted narrowings, folded here into both facets. A facet computed with
 *   its own filter applied is a facet that can only ever report the option
 *   you already clicked, so the service counts honour the status filter and
 *   the status counts honour the service filter, and neither honours itself.
 *   That is also what makes the default view honest: `resolved: 41` shows up
 *   under a list that is deliberately not showing them.
 *
 *   one head count of `error_events` in the last 24h. Platform-wide on
 *   purpose — it is the "is it on fire right now" number above the table, and
 *   a figure that moved every time somebody typed in the search box would
 *   answer a different question every time it was read.
 *
 * `q` matches the headline message or the operation. Not the stack: a
 * substring search over twenty-kilobyte texts is a table scan, and the
 * operation is the field an operator actually knows the name of.
 */
export async function listAdminErrors(
  query: AdminErrorListQuery = {},
): Promise<AdminErrorPage> {
  const { limit, offset } = pageBounds(query);
  const admin = getSupabaseAdmin();
  const term = searchTerm(query.q);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // The page. Built up rather than composed through a helper because the
  // status clause differs between this read and the facet sweep, and a shared
  // builder that took a flag for it would hide the one decision this function
  // is about.
  let pageQuery = admin
    .from("error_groups")
    .select(GROUP_COLUMNS, { count: "exact" });
  if (term) pageQuery = pageQuery.or(`message.ilike.*${term}*,operation.ilike.*${term}*`);
  if (query.service) pageQuery = pageQuery.eq("service", query.service);
  if (query.level) pageQuery = pageQuery.eq("level", query.level);
  // The decision documented at the top of this file: nothing asked for means
  // "what is still open", not "everything".
  pageQuery = query.status
    ? pageQuery.eq("status", query.status)
    : pageQuery.in("status", [...ADMIN_ERROR_DEFAULT_STATUSES]);

  // The facet sweep: the same narrowings minus BOTH facetted dimensions, so
  // one pass can answer for both of them. `service` is dropped here and
  // re-applied while folding.
  let facetQuery = admin.from("error_groups").select("service, status");
  if (term) facetQuery = facetQuery.or(`message.ilike.*${term}*,operation.ilike.*${term}*`);
  if (query.level) facetQuery = facetQuery.eq("level", query.level);

  const [page, facetRows, events24h] = await Promise.all([
    pageQuery
      .order("last_seen", { ascending: false })
      // A second key so paging is stable: two groups can share a `last_seen`
      // to the microsecond after one burst, and an ordering Postgres is free
      // to break either way drops rows between page one and page two.
      .order("id", { ascending: false })
      .range(offset, offset + limit - 1),
    facetQuery.limit(FACET_SCAN_MAX),
    admin
      .from("error_events")
      .select("id", { count: "exact", head: true })
      .gte("received_at", since24h),
  ]);

  if (page.error) throw new Error(`listAdminErrors: ${page.error.message}`);

  const items = ((page.data ?? []) as GroupRow[]).map(toAdminErrorGroup);
  const facets = foldFacets(
    (facetRows.data ?? []) as Array<{ service: string; status: string }>,
    query,
  );

  return {
    items,
    total: page.count ?? items.length,
    limit,
    offset,
    facets,
    events24h: events24h.count ?? 0,
  };
}

/**
 * The two facet lists, each blind to its own filter. Ordered by count, worst
 * first, so the filter bar reads like the list does; a value with no rows is
 * simply absent, which is the contract's rule — a service nothing has ever
 * broken in should not be offerable.
 */
function foldFacets(
  rows: Array<{ service: string; status: string }>,
  query: AdminErrorListQuery,
): AdminErrorPage["facets"] {
  const openStatuses = new Set<string>(ADMIN_ERROR_DEFAULT_STATUSES);
  const inStatusScope = (status: string): boolean =>
    query.status ? status === query.status : openStatuses.has(status);

  const services = new Map<string, number>();
  const statuses = new Map<string, number>();
  for (const row of rows) {
    // Service counts honour the status narrowing (including the default one)
    // but never their own: "worker: 12" has to stay visible while the list is
    // filtered to `api`, or the filter can only ever confirm itself.
    if (inStatusScope(row.status)) {
      services.set(row.service, (services.get(row.service) ?? 0) + 1);
    }
    // Status counts honour the service narrowing and ignore the status one
    // entirely — including the default — so "resolved: 41" is visible from a
    // list that is deliberately not showing the resolved.
    if (!query.service || row.service === query.service) {
      statuses.set(row.status, (statuses.get(row.status) ?? 0) + 1);
    }
  }

  return {
    services: [...services.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    // Statuses keep the vocabulary's own order — new, ack, resolved, ignored
    // is a triage ladder, and sorting it by count would shuffle it every time
    // somebody resolved something.
    statuses: ERROR_STATUSES.filter((id) => statuses.has(id)).map((id) => ({
      id,
      count: statuses.get(id) ?? 0,
    })),
  };
}

/**
 * One problem, its most recent occurrences and the people it reached.
 *
 * Null rather than a throw for "no such group": the id comes out of a URL, and
 * the routes turn it into a 404 — this way a caller that wants to ask whether
 * a group exists does not have to catch to find out.
 *
 * The per-user tallies come off `error_events`, which is sampled, so each
 * `count` is a floor: it is "at least this many times to this person", and
 * `users_affected` on the group — which the collector maintains on every
 * occurrence, sampled or not — is the honest headcount. A person whose every
 * occurrence was sampled away still appears, with a count of zero, because
 * `users_seen` remembers them.
 */
export async function getAdminErrorGroup(
  id: string,
): Promise<AdminErrorGroupDetail | null> {
  const admin = getSupabaseAdmin();
  const { data: group } = await admin
    .from("error_groups")
    .select(`${GROUP_COLUMNS}, users_seen`)
    .eq("id", id)
    .maybeSingle();
  if (!group) return null;
  const row = group as GroupRow & { users_seen: string[] | null };

  const [{ data: eventRows }, { data: userRows }] = await Promise.all([
    admin
      .from("error_events")
      .select(EVENT_COLUMNS)
      .eq("group_id", id)
      .order("received_at", { ascending: false })
      .limit(GROUP_EVENT_LIMIT),
    admin
      .from("error_events")
      .select("user_id")
      .eq("group_id", id)
      .limit(GROUP_USER_EVENT_SCAN),
  ]);

  const counts = new Map<string, number>();
  for (const uid of (row.users_seen ?? [])) counts.set(uid, 0);
  for (const e of (userRows ?? []) as Array<{ user_id: string | null }>) {
    if (!e.user_id) continue;
    counts.set(e.user_id, (counts.get(e.user_id) ?? 0) + 1);
  }

  const emails = await emailsForIds([...counts.keys()]);

  return {
    ...toAdminErrorGroup(row),
    events: ((eventRows ?? []) as EventRow[]).map(toAdminErrorEvent),
    users: [...counts.entries()]
      .map(([userId, count]) => ({
        id: userId,
        email: emails.get(userId) ?? null,
        count,
      }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
  };
}

/**
 * How far the address lookup reaches. Addresses live in the auth server,
 * which offers a paged list and nothing else — no join, no search — so this
 * is one walk of it, exactly as the organizations panel walks it, stopping as
 * soon as everyone asked for has been found.
 *
 * Past the cap the answer is the id and a null address, which the contract
 * allows on purpose: the id still identifies the person for a support reply,
 * and a detail screen that hung on a thousand-account walk to pretty up a
 * list of at most fifty ids would be the worse trade.
 */
const AUTH_PAGE = 200;
const AUTH_SCAN_CAP = 1_000;

async function emailsForIds(userIds: string[]): Promise<Map<string, string>> {
  const wanted = new Set(userIds);
  const out = new Map<string, string>();
  if (wanted.size === 0) return out;
  const admin = getSupabaseAdmin();
  for (let page = 1; page * AUTH_PAGE <= AUTH_SCAN_CAP; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: AUTH_PAGE,
    });
    // A telemetry screen that 500s because the auth server is unwell is a
    // screen missing precisely when it is needed; the ids stand alone.
    if (error) break;
    const batch = data?.users ?? [];
    for (const u of batch) {
      if (wanted.has(u.id) && u.email) out.set(u.id, u.email);
    }
    if (batch.length < AUTH_PAGE || out.size === wanted.size) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Writing                                                                   */
/* -------------------------------------------------------------------------- */

export interface AdminErrorPatch {
  status?: string;
  /** Empty or whitespace clears it — a note nobody stands behind any more is
   *  worse than none, and there is no other way to take one back. */
  note?: string | null;
}

/**
 * Triage: the two fields an operator owns.
 *
 * `resolved` is the only one that writes anything besides the column asked
 * for. It stamps `resolved_at` and copies the group's `last_release` into
 * `resolved_release`, so the row records WHEN it was called fixed and ON WHICH
 * BUILD — which is the pair that makes the reopen rule readable later: a group
 * that fires again on a newer release is a fix that did not hold, one that
 * fires again on the same release is a fix that never shipped.
 *
 * Moving off `resolved` clears `resolved_at` and keeps `resolved_release`,
 * which is exactly what `record_error_event` does when a resolved group fires
 * again. The release it was once called fixed on is a fact about the past;
 * the timestamp is a claim about the present, and the claim is what stops
 * being true.
 *
 * Note that the collector, not this function, is what reopens a group — an
 * operator resolving a live problem is not an argument, it is a bet that
 * loses by itself the next time it happens.
 */
export async function updateAdminErrorGroup(
  id: string,
  patch: AdminErrorPatch,
): Promise<AdminErrorGroupDetail> {
  const admin = getSupabaseAdmin();
  const { data: current } = await admin
    .from("error_groups")
    .select("id, status, last_release")
    .eq("id", id)
    .maybeSingle();
  if (!current) throw new AdminErrorError(404, "not_found");
  const before = current as { status: string; last_release: string | null };

  const update: Record<string, unknown> = {};

  if (patch.status !== undefined) {
    if (!ERROR_STATUSES.includes(patch.status as ErrorStatus)) {
      throw new AdminErrorError(
        400,
        "invalid_status",
        `Unknown status "${patch.status}". The statuses are ${ERROR_STATUSES.join(", ")}.`,
      );
    }
    update.status = patch.status;
    if (patch.status === "resolved") {
      update.resolved_at = new Date().toISOString();
      update.resolved_release = before.last_release;
    } else {
      update.resolved_at = null;
    }
  }

  if (patch.note !== undefined) {
    const note = (patch.note ?? "").trim();
    update.note = note.length > 0 ? note : null;
  }

  if (Object.keys(update).length === 0) {
    throw new AdminErrorError(400, "empty_patch", "Nothing to change.");
  }
  update.updated_at = new Date().toISOString();

  const { error } = await admin.from("error_groups").update(update).eq("id", id);
  if (error) throw new Error(`updateAdminErrorGroup: ${error.message}`);

  if (update.status && update.status !== before.status) {
    log.info("admin.error.triaged", {
      error_group_id: id,
      from: before.status,
      to: update.status,
      resolved_release: (update.resolved_release as string | null) ?? null,
    });
  }

  // Read back rather than patch the row in memory: the collector may have
  // written to this group between the update and now, and the screen the
  // operator is looking at should show what is true, not what was asked for.
  const detail = await getAdminErrorGroup(id);
  if (!detail) throw new AdminErrorError(404, "not_found");
  return detail;
}
