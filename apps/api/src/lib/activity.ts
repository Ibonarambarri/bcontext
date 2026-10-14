/**
 * Canonical human/agent change feed.
 *
 * Supabase workspaces persist an operational, redacted snapshot in `activity`.
 * `audit_log` remains the immutable hash chain and is correlated at read time;
 * demo workspaces use the same shape in a bounded in-memory buffer.
 */

import { correlationId } from "@bcontext-dev/contract/correlation";
import { parseWorkspaceRef } from "@bcontext-dev/contract/workspace-ref";
import {
  CHANGE_RETENTION_DAYS,
  decodeChangeCursor,
  encodeChangeCursor,
  redactChangeValue,
  type ChangeProvenance,
  type ChangeRelation,
  type ChangeReview,
  type ChangeSnapshot,
} from "@bcontext-dev/contract/changes";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { filterToReachBy } from "@/lib/storage/scoped";
import { agentDisplayNames } from "@/lib/agents/names";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Storage } from "@/lib/storage";
import { NODE_KINDS, type NodeKind } from "@bcontext-dev/contract/types";
import { isStrategicGoal } from "@bcontext-dev/contract/goals";

export type { ActivityEntry, ActivityKind, ChangeActor } from "@bcontext-dev/contract/activity";
import type { ActivityEntry, ActivityKind } from "@bcontext-dev/contract/activity";

export interface ActivityActor {
  /** Auth user id for human writes; owner user for user-scoped agent writes. */
  actorId?: string | null;
  actorKind?: "human" | "agent" | "system";
  /** Durable agent id (not the credential/token id). */
  principalId?: string | null;
  principalLabel?: string | null;
  /** Extra context is redacted before it reaches memory or storage. */
  payload?: Record<string, unknown>;
}

export interface ActivityListOptions {
  limit?: number;
  kinds?: ActivityKind[];
  actorKinds?: Array<"human" | "agent" | "system">;
  nodeKinds?: NodeKind[];
  tagId?: string;
  nodeId?: string;
  source?: string;
  since?: string;
  from?: string;
  to?: string;
  cursor?: string;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  next_cursor: string | null;
  retention: {
    operational_days: number;
    audit: "indefinite append-only hash chain";
  };
}

const MAX_PER_WORKSPACE = 200;
const buffers = new Map<string, ActivityEntry[]>();

const KIND_TO_VERB: Record<ActivityKind, string> = {
  create: "created",
  update: "updated",
  delete: "deleted",
  rename: "renamed",
  move: "moved",
  agent: "agent",
  workspace: "workspace",
};

/**
 * Append one change: synchronously into the per-workspace memory buffer
 * (what demo workspaces and tests read) and, when Supabase is configured,
 * fire-and-forget into `activity`. Never throws on the write path.
 */
export function record(
  workspace: string,
  kind: ActivityKind,
  node_id: string | null = null,
  node_title: string | null = null,
  summary: string | null = null,
  actor: ActivityActor = {},
): ActivityEntry {
  const payload = redactChangeValue({
    ...(actor.payload ?? {}),
    correlation_id: correlationId() ?? actor.payload?.correlation_id ?? null,
    principal_id: actor.principalId ?? actor.payload?.principal_id ?? null,
    principal_label: actor.principalLabel ?? actor.payload?.principal_label ?? null,
  }) as Record<string, unknown>;
  const entry = entryFromRow({
    id: `a-${Math.random().toString(36).slice(2, 10)}`,
    created_at: new Date().toISOString(),
    verb: KIND_TO_VERB[kind],
    target_node: node_id,
    actor_id: actor.actorId ?? null,
    actor_kind: actor.actorKind ?? "human",
    payload: { ...payload, node_id, title: node_title, summary },
  });
  const buf = buffers.get(workspace) ?? [];
  buf.push(entry);
  if (buf.length > MAX_PER_WORKSPACE) buf.splice(0, buf.length - MAX_PER_WORKSPACE);
  buffers.set(workspace, buf);

  if (isSupabaseConfigured()) {
    void persistToSupabase({
      slug: workspace,
      kind,
      node_id,
      node_title,
      summary,
      actor: { ...actor, payload },
    }).catch((error) => console.warn("[activity] supabase insert failed:", error));
  }
  return entry;
}

/** Back-compatible reader for inspector/drawer call sites. */
export async function listForStorage(
  storage: Storage,
  workspaceSlug: string,
  options: ActivityListOptions = {},
): Promise<ActivityEntry[]> {
  return (await listChangePageForStorage(storage, workspaceSlug, options)).entries;
}

/** Shared reader for Changes REST and MCP, always scoped by workspace id. */
export async function listChangePageForStorage(
  storage: Storage,
  workspaceSlug: string,
  options: ActivityListOptions = {},
): Promise<ActivityPage> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  if (storage.backend !== "supabase") {
    let filtered = filterEntries(list(workspaceSlug, MAX_PER_WORKSPACE), options);
    if (options.cursor) {
      const cursor = decodeChangeCursor(options.cursor);
      if (!cursor) throw new Error("invalid changes cursor");
      const index = filtered.findIndex((entry) => entry.id === cursor.id && entry.ts === cursor.ts);
      filtered = index >= 0 ? filtered.slice(index + 1) : [];
    }
    const entries = filtered.slice(0, limit);
    return page(entries, filtered.length > limit ? entries.at(-1) ?? null : null);
  }

  const admin = getSupabaseAdmin();
  let query = admin
    .from("activity")
    .select("id,verb,target_node,actor_id,actor_kind,payload,created_at")
    .eq("workspace_id", storage.workspace.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (options.since) query = query.gt("created_at", options.since);
  if (options.from) query = query.gte("created_at", options.from);
  if (options.to) query = query.lte("created_at", options.to);
  if (options.nodeId) {
    query = query.or(`target_node.eq.${options.nodeId},payload->>node_id.eq.${options.nodeId}`);
  }
  if (options.kinds?.length) query = query.in("verb", options.kinds.flatMap(activityKindVerbs));
  if (options.actorKinds?.length) query = query.in("actor_kind", options.actorKinds);
  if (options.nodeKinds?.length) query = query.in("payload->>node_kind", options.nodeKinds);
  if (options.tagId) query = query.contains("payload", { tag_ids: [options.tagId] });
  if (options.source) query = query.eq("payload->>source", options.source);
  if (options.cursor) {
    const cursor = decodeChangeCursor(options.cursor);
    if (!cursor) throw new Error("invalid changes cursor");
    query = query.or(`created_at.lt.${cursor.ts},and(created_at.eq.${cursor.ts},id.lt.${cursor.id})`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`activity: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  // Narrow to the caller's reach before anything is returned. The change feed
  // carries full before/after markdown snapshots in `payload`, so without this
  // a principal restricted to a slice of the graph could read the rest of the
  // workspace through its history — the largest hole outside the storage seam.
  //
  // Filtering happens after the query rather than inside it because reach is
  // resolved from tags, and a deleted node has none left to test. A short page
  // is the acceptable cost: the cursor still advances, so paging continues to
  // work, and an unrestricted principal is unaffected.
  // Slice to the page BEFORE filtering. The query fetches limit+1 rows to detect
  // a next page; filtering first could pull the (limit+1)-th row into view while
  // the cursor still pointed at the limit-th, so the next page would re-return
  // an entry the client already rendered.
  const mapped = rows.slice(0, limit).map(entryFromRow);
  const entries = await filterToReachBy(storage, mapped, (entry) => entry.node_id);
  await Promise.all([
    attachAuditEvidence(admin, storage.workspace.id, entries),
    attachActorNames(entries),
  ]);
  // The cursor comes from the last row on this page, not the last one that
  // survived the reach filter. Deriving it from the visible list stops paging
  // dead whenever a whole page is filtered out — the client would conclude the
  // history ended while reachable entries still sit further back.
  const cursorFrom = mapped.at(-1) ?? null;
  return page(entries, hasMore ? cursorFrom : null);
}

/**
 * Feed-row projection of an entry: everything the list row paints (actor,
 * action, node, source, review/audit markers) with the heavy diff material
 * (before/after snapshots, relations, provenance) stripped. `snapshot_state`
 * is preserved so a client knows whether fetching the full entry will yield
 * a diff. A 40-row page shrinks from ~hundreds of KB (two full markdown
 * snapshots per row) to a few KB.
 */
export function slimActivityEntry(entry: ActivityEntry): ActivityEntry {
  return {
    ...entry,
    before: null,
    after: null,
    affected_relations: [],
    provenance: { via: entry.provenance.via, sources: [], references: [] },
  };
}

/** One full entry by id — the lazy detail behind an expanded feed row. */
export async function getChangeEntryForStorage(
  storage: Storage,
  workspaceSlug: string,
  entryId: string,
): Promise<ActivityEntry | null> {
  if (storage.backend !== "supabase") {
    return list(workspaceSlug, MAX_PER_WORKSPACE).find((entry) => entry.id === entryId) ?? null;
  }
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("activity")
    .select("id,verb,target_node,actor_id,actor_kind,payload,created_at")
    .eq("workspace_id", storage.workspace.id)
    .eq("id", entryId)
    .maybeSingle();
  if (error) throw new Error(`activity entry: ${error.message}`);
  if (!data) return null;
  const entry = entryFromRow(data as Record<string, unknown>);
  // The detail view is where the full before/after snapshots live, so it needs
  // the same reach check as the feed. Out of reach reads as absent, matching
  // how every other surface reports it.
  const [visible] = await filterToReachBy(storage, [entry], (e) => e.node_id);
  if (!visible) return null;
  await Promise.all([
    attachAuditEvidence(admin, storage.workspace.id, [visible]),
    attachActorNames([visible]),
  ]);
  return visible;
}

export interface ActivityFacets {
  /** Distinct `payload->>source` values over the recent feed window. */
  sources: string[];
}

/**
 * Lightweight filter options for the Changes view. One single-column query
 * over the recent window — the client never has to page the whole feed just
 * to populate a `<Select>`.
 */
/**
 * Known side channel, stated rather than discovered.
 *
 * Facets aggregate `payload->>source` across the workspace's activity, so a
 * narrowed principal learns which connectors produce changes in parts of the
 * graph it cannot see — source names, never content. Filtering it properly
 * means resolving the reach for a query whose whole point is to be one cheap
 * aggregate, so it is left open deliberately and listed here with
 * `countTagUsage` rather than left for someone to find.
 */
export async function listChangeFacetsForStorage(
  storage: Storage,
  workspaceSlug: string,
  opts: { window?: number } = {},
): Promise<ActivityFacets> {
  const window = Math.max(1, Math.min(5000, opts.window ?? 1000));
  if (storage.backend !== "supabase") {
    const sources = new Set<string>();
    for (const entry of list(workspaceSlug, MAX_PER_WORKSPACE)) {
      if (entry.source) sources.add(entry.source);
    }
    return { sources: [...sources].sort() };
  }
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("activity")
    .select("source:payload->>source")
    .eq("workspace_id", storage.workspace.id)
    .order("created_at", { ascending: false })
    .limit(window);
  if (error) throw new Error(`activity facets: ${error.message}`);
  const sources = new Set<string>();
  for (const row of (data ?? []) as Array<{ source: string | null }>) {
    if (typeof row.source === "string" && row.source.length > 0) sources.add(row.source);
  }
  return { sources: [...sources].sort() };
}

function page(entries: ActivityEntry[], last: ActivityEntry | null): ActivityPage {
  return {
    entries,
    next_cursor: last ? encodeChangeCursor({ ts: last.ts, id: last.id }) : null,
    retention: {
      operational_days: CHANGE_RETENTION_DAYS,
      audit: "indefinite append-only hash chain",
    },
  };
}

function filterEntries(entries: ActivityEntry[], options: ActivityListOptions): ActivityEntry[] {
  return entries
    .filter((entry) => !options.since || entry.ts > options.since)
    .filter((entry) => !options.from || entry.ts >= options.from)
    .filter((entry) => !options.to || entry.ts <= options.to)
    .filter((entry) => !options.nodeId || entry.node_id === options.nodeId)
    .filter((entry) => !options.kinds?.length || options.kinds.includes(entry.kind))
    .filter((entry) => !options.actorKinds?.length || (entry.actor_kind !== null && options.actorKinds.includes(entry.actor_kind)))
    .filter((entry) => !options.nodeKinds?.length || (entry.node_kind !== null && options.nodeKinds.includes(entry.node_kind)))
    .filter((entry) => !options.tagId || entry.tag_ids.includes(options.tagId))
    .filter((entry) => !options.source || entry.source === options.source);
}

/**
 * Did this entry touch a goal that steers the company?
 *
 * Read from the snapshot rather than stamped by whoever wrote the change: a
 * flag each write path has to remember is a flag the next write path forgets,
 * and deriving it means the answer is also right for every entry recorded
 * before goals existed. `after` first, `before` for a delete — a company goal
 * that was just demoted or removed is exactly the change worth hearing about.
 */
function isStrategicChange(
  before: ChangeSnapshot | null,
  after: ChangeSnapshot | null,
): boolean {
  return [after, before].some(
    (snapshot) => snapshot !== null && isStrategicGoal({ kind: snapshot.kind, data: snapshot.data }),
  );
}

function entryFromRow(raw: Record<string, unknown>): ActivityEntry {
  const payload = raw.payload && typeof raw.payload === "object" ? raw.payload as Record<string, unknown> : {};
  const verb = typeof raw.verb === "string" ? raw.verb : "updated";
  const actorKind = raw.actor_kind === "human" || raw.actor_kind === "agent" || raw.actor_kind === "system" ? raw.actor_kind : null;
  const actorId = typeof raw.actor_id === "string" ? raw.actor_id : null;
  const principalId = stringOrNull(payload.principal_id);
  const principalLabel = stringOrNull(payload.principal_label);
  const actorLabel = principalLabel ?? defaultActorLabel(actorKind, principalId ?? actorId);
  const before = snapshotOrNull(payload.before);
  const after = snapshotOrNull(payload.after);
  return {
    id: String(raw.id),
    ts: String(raw.created_at),
    kind: activityKindFromVerb(verb),
    action: verb,
    node_id: stringOrNull(raw.target_node) ?? stringOrNull(payload.node_id),
    node_title: stringOrNull(payload.title),
    node_kind: isNodeKind(payload.node_kind) ? payload.node_kind : null,
    block_id: stringOrNull(payload.block_id),
    summary: stringOrNull(payload.summary),
    actor_kind: actorKind,
    actor_id: actorId,
    actor_principal_id: principalId,
    actor_label: actorLabel,
    actor: { kind: actorKind, id: principalId ?? actorId, name: actorLabel },
    correlation_id: stringOrNull(payload.correlation_id),
    source: stringOrNull(payload.source),
    tag_ids: stringArray(payload.tag_ids),
    tag_slugs: stringArray(payload.tag_slugs),
    before,
    after,
    strategic: isStrategicChange(before, after),
    snapshot_state: payload.snapshot_state === "available" || payload.snapshot_state === "redacted" ? payload.snapshot_state : "not_recorded",
    affected_relations: Array.isArray(payload.affected_relations) ? payload.affected_relations as ChangeRelation[] : [],
    provenance: provenanceOrEmpty(payload.provenance),
    review: reviewOrNull(payload.review),
    revert: revertOrFallback(payload.revert),
    audit: null,
  };
}

/**
 * Put the agent's current name on every agent entry of a page. The label
 * stored at write time is the fallback, not the source: rows written before
 * labels existed carry none, and an agent renamed since should read by its
 * new name. One cached lookup per page, never a failure — see
 * `@/lib/agents/names`.
 */
async function attachActorNames(entries: ActivityEntry[]): Promise<void> {
  const agentIds = entries
    .filter((entry) => entry.actor_kind === "agent" && entry.actor_principal_id)
    .map((entry) => entry.actor_principal_id as string);
  if (agentIds.length === 0) return;
  const names = await agentDisplayNames(agentIds);
  for (const entry of entries) {
    const name = entry.actor_principal_id ? names.get(entry.actor_principal_id) : undefined;
    if (!name) continue;
    entry.actor_label = name;
    entry.actor = { ...entry.actor, name };
  }
}

async function attachAuditEvidence(
  admin: ReturnType<typeof getSupabaseAdmin>,
  workspaceId: string,
  entries: ActivityEntry[],
): Promise<void> {
  const correlations = [...new Set(entries.map((entry) => entry.correlation_id).filter((id): id is string => Boolean(id)))];
  if (correlations.length === 0) return;
  const { data } = await admin
    .from("audit_log")
    .select("id,action,target_id,correlation_id,row_hash,input_hash,output_hash")
    .eq("workspace_id", workspaceId)
    .in("correlation_id", correlations);
  for (const raw of data ?? []) {
    const entry = entries.find((candidate) =>
      candidate.correlation_id === raw.correlation_id &&
      (!raw.target_id || candidate.node_id === raw.target_id),
    );
    if (!entry || entry.audit) continue;
    entry.audit = {
      id: String(raw.id),
      action: String(raw.action),
      row_hash: String(raw.row_hash),
      input_hash: stringOrNull(raw.input_hash),
      output_hash: stringOrNull(raw.output_hash),
    };
  }
}

/** Newest-first read of the memory buffer only (demo/tests); persisted feeds use `*ForStorage`. */
export function list(workspace: string, limit = 50, kinds?: ActivityKind[]): ActivityEntry[] {
  const buf = buffers.get(workspace) ?? [];
  const filtered = kinds?.length ? buf.filter((entry) => kinds.includes(entry.kind)) : buf;
  return filtered.slice(Math.max(0, filtered.length - limit)).reverse();
}

/**
 * The workspace an entry belongs to, from however the caller named it: an
 * id, or `<org>/<workspace>`. A bare slug is resolved only when exactly one
 * workspace answers to it — with organizations holding many workspaces the
 * same name lives in several, and attributing someone's activity to another
 * company's project is not a mistake anyone would catch by reading a feed.
 */
async function resolveWorkspaceId(
  admin: ReturnType<typeof getSupabaseAdmin>,
  named: string,
): Promise<string | null> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(named)) {
    return named;
  }
  const ref = parseWorkspaceRef(named);
  if (ref) {
    const { data } = await admin
      .from("workspaces")
      .select("id, organization:organizations!inner(slug)")
      .eq("slug", ref.workspace)
      .eq("organization.slug", ref.org)
      .maybeSingle();
    return (data?.id as string | undefined) ?? null;
  }
  const { data } = await admin.from("workspaces").select("id").eq("slug", named).limit(2);
  const rows = (data ?? []) as Array<{ id: string }>;
  return rows.length === 1 ? (rows[0]?.id ?? null) : null;
}

async function persistToSupabase(args: {
  slug: string;
  kind: ActivityKind;
  node_id: string | null;
  node_title: string | null;
  summary: string | null;
  actor: ActivityActor;
}): Promise<void> {
  const admin = getSupabaseAdmin();
  const workspace = await resolveWorkspaceId(admin, args.slug);
  if (!workspace) return;
  const payload = redactChangeValue({
    ...(args.actor.payload ?? {}),
    title: args.node_title,
    summary: args.summary,
    node_id: args.node_id,
    principal_id: args.actor.principalId ?? args.actor.payload?.principal_id ?? null,
    principal_label: args.actor.principalLabel ?? args.actor.payload?.principal_label ?? null,
    correlation_id: correlationId() ?? args.actor.payload?.correlation_id ?? null,
  });
  const { error: insertError } = await admin.from("activity").insert({
    workspace_id: workspace,
    actor_id: args.actor.actorId ?? null,
    actor_kind: args.actor.actorKind ?? "human",
    verb: KIND_TO_VERB[args.kind],
    target_node: args.kind === "delete" ? null : args.node_id,
    payload,
  });
  if (insertError) throw insertError;
}

function activityKindVerbs(kind: ActivityKind): string[] {
  if (kind === "create") return ["create", "created"];
  if (kind === "update") return ["update", "updated"];
  if (kind === "delete") return ["delete", "deleted"];
  if (kind === "rename") return ["rename", "renamed"];
  if (kind === "move") return ["move", "moved"];
  return [kind];
}

function activityKindFromVerb(verb: string): ActivityKind {
  if (verb === "created" || verb === "create") return "create";
  if (verb === "deleted" || verb === "delete") return "delete";
  if (verb === "renamed" || verb === "rename") return "rename";
  if (verb === "moved" || verb === "move") return "move";
  if (verb === "agent") return "agent";
  if (verb === "workspace") return "workspace";
  return "update";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function defaultActorLabel(kind: ActivityEntry["actor_kind"], id: string | null): string {
  const suffix = id ? ` · ${id.slice(0, 8)}` : "";
  return kind === "agent" ? `Agent${suffix}` : kind === "system" ? `System${suffix}` : `Human${suffix}`;
}
function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === "string" && (NODE_KINDS as readonly string[]).includes(value);
}
function snapshotOrNull(value: unknown): ChangeSnapshot | null {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>).title === "string" ? value as ChangeSnapshot : null;
}
function provenanceOrEmpty(value: unknown): ChangeProvenance {
  if (!value || typeof value !== "object") return { via: null, sources: [], references: [] };
  const raw = value as Record<string, unknown>;
  return { via: stringOrNull(raw.via), sources: stringArray(raw.sources), references: stringArray(raw.references) };
}
function reviewOrNull(value: unknown): ChangeReview | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.status !== "pending" && raw.status !== "accepted" && raw.status !== "rejected") return null;
  return { status: raw.status, label: stringOrNull(raw.label) ?? "Review proposal", review_url: stringOrNull(raw.review_url) };
}
function revertOrFallback(value: unknown): ActivityEntry["revert"] {
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    return { available: raw.available === true, reason: stringOrNull(raw.reason) ?? "No audited compensation contract was supplied." };
  }
  return { available: false, reason: "No audited compensation contract was supplied for this change." };
}
