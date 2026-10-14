/**
 * Persistence for Nexos: the `nexos` rows and everything hanging off them —
 * bindings, runs, inbox items, message windows — over both backends. Postgres
 * (service-role client) for real workspaces; module-level maps for demo
 * workspaces and the test suite, with the same semantics, so the routes and
 * the runtime run unchanged without Supabase.
 *
 * Callers: `./lifecycle` and `./general` (rows), the `/api/nexos/*` routes,
 * the runtime (`createRun`/`finishRun`, inbox) and the triggers (windows,
 * heartbeats). Pure data layer: no authorisation here — callers prove access
 * with `openWorkspace` first, and every per-workspace read is filtered by the
 * target's workspace id so a wrong-tenant id simply is not found.
 *
 * Must not break:
 *   - Creating or deleting a Nexo is `./lifecycle`'s job (agent row + grant);
 *     `insertNexoRow`/`deleteNexoRow` here are the row half only.
 *   - Window appends and claims are atomic in Postgres (RPCs in 0096); the
 *     memory path mirrors them so the trigger code has one contract.
 *   - `resolveInboxItem` only moves an item out of `open` (compare-and-set):
 *     two people approving the same draft must not send it twice.
 */
import { randomUUID } from "node:crypto";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import {
  DEFAULT_NEXO_BRAIN_TOOLS,
  DEFAULT_NEXO_ESCALATION,
  DEFAULT_NEXO_HEARTBEAT,
  NEXO_AUTONOMY,
  NEXO_BINDING_MODES,
  NEXO_INBOX_KINDS,
  NEXO_INBOX_STATUSES,
  NEXO_RUN_STATUSES,
  NEXO_RUN_TRIGGERS,
  NexoBrainToolsSchema,
  NexoEscalationSchema,
  NexoHeartbeatSchema,
  nexoSlug,
  type Nexo,
  type NexoBinding,
  type NexoBindingMode,
  type NexoInboxItem,
  type NexoInboxStatus,
  type NexoRun,
  type NexoSession,
} from "@bcontext-dev/contract/nexos";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Storage, StorageBackend } from "@/lib/storage";
import {
  WINDOW_DEFAULTS,
  type AppendWindowEventInput,
  type CreateInboxItemInput,
  type CreateRunInput,
  type FinishRunInput,
  type NewNexoRow,
  type NexoRowPatch,
  type NexoTarget,
  type NexoWindow,
  type NexoWindowEvent,
  type ResolveInboxItemInput,
} from "./types";

/** A slug, name or scope key some other Nexo already owns. */
export class NexoConflictError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "NexoConflictError";
  }
}

export function nexoTarget(storage: Pick<Storage, "backend" | "workspace">): NexoTarget {
  return { workspaceId: storage.workspace.id, backend: storage.backend };
}

/** Backend for the scans that span every workspace (heartbeats, windows). */
function defaultBackend(): StorageBackend {
  return isSupabaseConfigured() ? "supabase" : "demo";
}

const now = () => new Date().toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* -------------------------------------------------------------------------- */
/*  Memory backend                                                            */
/* -------------------------------------------------------------------------- */

const mem = {
  nexos: new Map<string, Nexo>(),
  bindings: new Map<string, NexoBinding>(),
  runs: new Map<string, NexoRun>(),
  inbox: new Map<string, NexoInboxItem>(),
  windows: new Map<string, NexoWindow>(),
};

/** Test seam: forget every in-memory Nexo, binding, run, inbox item and window. */
export function resetNexoStoreForTests(): void {
  for (const map of Object.values(mem)) map.clear();
}

function byNewest<T>(key: (row: T) => string) {
  return (a: T, b: T) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0);
}

/* -------------------------------------------------------------------------- */
/*  Row mapping                                                               */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
function oneOf<T extends string>(values: readonly T[], v: unknown, fallback: T): T {
  return typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : fallback;
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function rowToNexo(row: Row): Nexo {
  const brain = NexoBrainToolsSchema.safeParse(row.brain_tools);
  const heartbeat = NexoHeartbeatSchema.safeParse(row.heartbeat);
  const escalation = NexoEscalationSchema.safeParse(row.escalation);
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    agent_id: String(row.agent_id),
    slug: String(row.slug),
    name: String(row.name),
    description: str(row.description) ?? "",
    is_general: row.is_general === true,
    template: str(row.template) ?? "custom",
    questionnaire: obj(row.questionnaire),
    prompt_md: str(row.prompt_md) ?? "",
    model: str(row.model),
    autonomy: oneOf(NEXO_AUTONOMY, row.autonomy, "draft"),
    brain_tools: brain.success ? brain.data : DEFAULT_NEXO_BRAIN_TOOLS,
    heartbeat: heartbeat.success ? heartbeat.data : DEFAULT_NEXO_HEARTBEAT,
    escalation: escalation.success ? escalation.data : DEFAULT_NEXO_ESCALATION,
    monthly_budget_credits: num(row.monthly_budget_credits),
    status: row.status === "paused" ? "paused" : "active",
    last_run_at: str(row.last_run_at),
    next_heartbeat_at: str(row.next_heartbeat_at),
    created_by: str(row.created_by),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? row.created_at ?? ""),
  };
}

function rowToBinding(row: Row): NexoBinding {
  return {
    id: String(row.id),
    nexo_id: String(row.nexo_id),
    workspace_id: String(row.workspace_id),
    install_id: String(row.install_id),
    connector_id: String(row.connector_id),
    scope_key: str(row.scope_key) ?? "*",
    scope: obj(row.scope),
    mode: oneOf(NEXO_BINDING_MODES, row.mode, "listen"),
    created_by: str(row.created_by),
    created_at: String(row.created_at ?? ""),
  };
}

function rowToRun(row: Row): NexoRun {
  return {
    id: String(row.id),
    nexo_id: String(row.nexo_id),
    workspace_id: String(row.workspace_id),
    trigger: oneOf(NEXO_RUN_TRIGGERS, row.trigger, "manual"),
    status: oneOf(NEXO_RUN_STATUSES, row.status, "running"),
    input: obj(row.input),
    output_md: str(row.output_md),
    steps: Array.isArray(row.steps) ? (row.steps as NexoRun["steps"]) : [],
    usage: obj(row.usage),
    error: str(row.error),
    started_at: String(row.started_at ?? ""),
    finished_at: str(row.finished_at),
  };
}

function rowToInbox(row: Row): NexoInboxItem {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    nexo_id: String(row.nexo_id),
    run_id: str(row.run_id),
    kind: oneOf(NEXO_INBOX_KINDS, row.kind, "escalation"),
    title: String(row.title ?? ""),
    body_md: str(row.body_md) ?? "",
    payload: obj(row.payload),
    status: oneOf(NEXO_INBOX_STATUSES, row.status, "open"),
    resolved_by: str(row.resolved_by),
    resolved_at: str(row.resolved_at),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? row.created_at ?? ""),
  };
}

function rowToWindow(row: Row): NexoWindow {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    nexo_id: String(row.nexo_id),
    binding_id: str(row.binding_id),
    source_key: String(row.source_key),
    events: Array.isArray(row.events) ? (row.events as NexoWindowEvent[]) : [],
    message_count: num(row.message_count) ?? 0,
    first_at: String(row.first_at),
    last_at: String(row.last_at),
    flush_after: String(row.flush_after),
    state: row.state === "flushing" ? "flushing" : row.state === "flushed" ? "flushed" : "collecting",
    claimed_at: str(row.claimed_at),
    flushed_at: str(row.flushed_at),
    created_at: String(row.created_at ?? row.first_at ?? ""),
  };
}

function fail(op: string, error: { message: string }): never {
  throw new Error(`nexos.${op}: ${error.message}`);
}

/* -------------------------------------------------------------------------- */
/*  Nexos                                                                     */
/* -------------------------------------------------------------------------- */

/** Every Nexo in the workspace, the general one first, then by creation. */
export async function listNexos(t: NexoTarget): Promise<Nexo[]> {
  let rows: Nexo[];
  if (t.backend === "demo") {
    rows = [...mem.nexos.values()].filter((n) => n.workspace_id === t.workspaceId);
  } else {
    const { data, error } = await getSupabaseAdmin()
      .from("nexos")
      .select("*")
      .eq("workspace_id", t.workspaceId)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) fail("list", error);
    rows = ((data ?? []) as Row[]).map(rowToNexo);
  }
  return rows.sort((a, b) =>
    a.is_general !== b.is_general ? (a.is_general ? -1 : 1) : a.created_at.localeCompare(b.created_at),
  );
}

export async function getNexo(t: NexoTarget, id: string): Promise<Nexo | null> {
  if (t.backend === "demo") {
    const n = mem.nexos.get(id);
    return n && n.workspace_id === t.workspaceId ? n : null;
  }
  if (!UUID.test(id)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("nexos")
    .select("*")
    .eq("workspace_id", t.workspaceId)
    .eq("id", id)
    .maybeSingle();
  if (error) fail("get", error);
  return data ? rowToNexo(data as Row) : null;
}

export async function getGeneralNexo(t: NexoTarget): Promise<Nexo | null> {
  if (t.backend === "demo") {
    return [...mem.nexos.values()].find((n) => n.workspace_id === t.workspaceId && n.is_general) ?? null;
  }
  const { data, error } = await getSupabaseAdmin()
    .from("nexos")
    .select("*")
    .eq("workspace_id", t.workspaceId)
    .eq("is_general", true)
    .maybeSingle();
  if (error) fail("get_general", error);
  return data ? rowToNexo(data as Row) : null;
}

/**
 * The Nexo an agent principal belongs to, from any workspace. The runtime
 * uses it to go from an `agents.id` (what grants and activity carry) back to
 * the Nexo. `backend` defaults to Postgres when it is configured.
 */
export async function getNexoByAgentId(
  agentId: string,
  opts: { backend?: StorageBackend } = {},
): Promise<Nexo | null> {
  if ((opts.backend ?? defaultBackend()) === "demo") {
    return [...mem.nexos.values()].find((n) => n.agent_id === agentId) ?? null;
  }
  const { data, error } = await getSupabaseAdmin()
    .from("nexos")
    .select("*")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (error) fail("get_by_agent", error);
  return data ? rowToNexo(data as Row) : null;
}

/** By id across workspaces — for worker jobs that carry only the Nexo id. */
export async function getNexoById(
  id: string,
  opts: { backend?: StorageBackend } = {},
): Promise<Nexo | null> {
  if ((opts.backend ?? defaultBackend()) === "demo") return mem.nexos.get(id) ?? null;
  if (!UUID.test(id)) return null;
  const { data, error } = await getSupabaseAdmin().from("nexos").select("*").eq("id", id).maybeSingle();
  if (error) fail("get_by_id", error);
  return data ? rowToNexo(data as Row) : null;
}

/** `nexoSlug(name)`, suffixed `-2`, `-3`… until it is free in the workspace. */
export async function uniqueNexoSlug(t: NexoTarget, name: string): Promise<string> {
  const base = nexoSlug(name);
  const taken = new Set((await listNexos(t)).map((n) => n.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 48 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 39)}-${randomUUID().slice(0, 8)}`;
}

/**
 * Insert the row half of a Nexo. Throws `NexoConflictError("general_exists")`
 * when a second general Nexo races in, and `("slug_taken")` on a slug clash.
 */
export async function insertNexoRow(t: NexoTarget, row: NewNexoRow): Promise<Nexo> {
  if (t.backend === "demo") {
    const all = [...mem.nexos.values()].filter((n) => n.workspace_id === t.workspaceId);
    if (row.is_general && all.some((n) => n.is_general)) throw new NexoConflictError("general_exists");
    if (all.some((n) => n.slug === row.slug)) throw new NexoConflictError("slug_taken");
    const at = now();
    const nexo: Nexo = {
      ...row,
      id: randomUUID(),
      workspace_id: t.workspaceId,
      status: "active",
      last_run_at: null,
      next_heartbeat_at: null,
      created_at: at,
      updated_at: at,
    };
    mem.nexos.set(nexo.id, nexo);
    return nexo;
  }
  const { data, error } = await getSupabaseAdmin()
    .from("nexos")
    .insert({ ...row, workspace_id: t.workspaceId })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new NexoConflictError(
        error.message.includes("nexos_one_general") ? "general_exists" : "slug_taken",
      );
    }
    fail("insert", error);
  }
  return rowToNexo(data as Row);
}

export async function updateNexoRow(t: NexoTarget, id: string, patch: NexoRowPatch): Promise<Nexo | null> {
  if (t.backend === "demo") {
    const current = await getNexo(t, id);
    if (!current) return null;
    const next: Nexo = { ...current, ...patch, updated_at: now() };
    mem.nexos.set(id, next);
    return next;
  }
  if (!UUID.test(id)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("nexos")
    .update(patch)
    .eq("workspace_id", t.workspaceId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) fail("update", error);
  return data ? rowToNexo(data as Row) : null;
}

/** Delete the row (cascades bindings, runs, inbox, windows and its chat sessions). */
export async function deleteNexoRow(t: NexoTarget, id: string): Promise<boolean> {
  if (t.backend === "demo") {
    const current = await getNexo(t, id);
    if (!current) return false;
    mem.nexos.delete(id);
    for (const map of [mem.bindings, mem.runs, mem.inbox, mem.windows] as Array<Map<string, { nexo_id: string }>>) {
      for (const [key, value] of map) if (value.nexo_id === id) map.delete(key);
    }
    return true;
  }
  const { data, error } = await getSupabaseAdmin()
    .from("nexos")
    .delete()
    .eq("workspace_id", t.workspaceId)
    .eq("id", id)
    .select("id");
  if (error) fail("delete", error);
  return (data ?? []).length > 0;
}

/**
 * A connector install of THIS workspace that can be bound (not uninstalled),
 * or null. Filtered by workspace in the query, so a caller-supplied install
 * id from another tenant is simply not found.
 */
export async function getBindableInstall(
  t: NexoTarget,
  installId: string,
): Promise<{ id: string; connector_id: string } | null> {
  if (t.backend === "demo" || !UUID.test(installId)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("connector_installs")
    .select("id,connector_id,status")
    .eq("workspace_id", t.workspaceId)
    .eq("id", installId)
    .neq("status", "uninstalled")
    .maybeSingle();
  if (error) fail("get_install", error);
  return data ? { id: String(data.id), connector_id: String(data.connector_id) } : null;
}

/* -------------------------------------------------------------------------- */
/*  Heartbeats                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Active Nexos whose `next_heartbeat_at` is due, across every workspace.
 * Says nothing about active hours, budget or whether the heartbeat is still
 * enabled — the trigger decides; it advances `next_heartbeat_at` with
 * `setNextHeartbeat` under a compare-and-set so two runners never both fire.
 */
export async function listDueHeartbeats(
  opts: { now?: Date; limit?: number; backend?: StorageBackend } = {},
): Promise<Nexo[]> {
  const at = (opts.now ?? new Date()).toISOString();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  if ((opts.backend ?? defaultBackend()) === "demo") {
    return [...mem.nexos.values()]
      .filter((n) => n.status === "active" && n.next_heartbeat_at !== null && n.next_heartbeat_at <= at)
      .sort((a, b) => a.next_heartbeat_at!.localeCompare(b.next_heartbeat_at!))
      .slice(0, limit);
  }
  const { data, error } = await getSupabaseAdmin()
    .from("nexos")
    .select("*")
    .eq("status", "active")
    .not("next_heartbeat_at", "is", null)
    .lte("next_heartbeat_at", at)
    .order("next_heartbeat_at", { ascending: true })
    .limit(limit);
  if (error) fail("due_heartbeats", error);
  return ((data ?? []) as Row[]).map(rowToNexo);
}

/**
 * Active Nexos with the heartbeat switched on but no beat scheduled yet —
 * just enabled, or their cadence changed (`updateNexo` clears the clock so
 * the trigger reschedules it with the active hours in mind).
 */
export async function listUnscheduledHeartbeats(
  opts: { limit?: number; backend?: StorageBackend } = {},
): Promise<Nexo[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  if ((opts.backend ?? defaultBackend()) === "demo") {
    return [...mem.nexos.values()]
      .filter((n) => n.status === "active" && n.heartbeat.enabled && n.next_heartbeat_at === null)
      .slice(0, limit);
  }
  const { data, error } = await getSupabaseAdmin()
    .from("nexos")
    .select("*")
    .eq("status", "active")
    .is("next_heartbeat_at", null)
    .filter("heartbeat->>enabled", "eq", "true")
    .limit(limit);
  if (error) fail("unscheduled_heartbeats", error);
  return ((data ?? []) as Row[]).map(rowToNexo);
}

/**
 * Move `next_heartbeat_at` to `next` (null = no heartbeat scheduled). With
 * `expected` it is a compare-and-set: the write only lands when the stored
 * value still equals `expected`, and the return says whether it did — a
 * `false` means another runner already took this beat.
 */
export async function setNextHeartbeat(
  t: NexoTarget,
  nexoId: string,
  next: string | null,
  opts: { expected?: string | null } = {},
): Promise<boolean> {
  if (t.backend === "demo") {
    const current = await getNexo(t, nexoId);
    if (!current) return false;
    if (opts.expected !== undefined && !sameInstant(current.next_heartbeat_at, opts.expected)) return false;
    mem.nexos.set(nexoId, { ...current, next_heartbeat_at: next });
    return true;
  }
  let query = getSupabaseAdmin()
    .from("nexos")
    .update({ next_heartbeat_at: next })
    .eq("workspace_id", t.workspaceId)
    .eq("id", nexoId);
  if (opts.expected !== undefined) {
    query = opts.expected === null ? query.is("next_heartbeat_at", null) : query.eq("next_heartbeat_at", opts.expected);
  }
  const { data, error } = await query.select("id");
  if (error) fail("set_next_heartbeat", error);
  return (data ?? []).length > 0;
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

/* -------------------------------------------------------------------------- */
/*  Bindings                                                                  */
/* -------------------------------------------------------------------------- */

/** Bindings of the workspace, or of one Nexo. */
export async function listBindings(t: NexoTarget, nexoId?: string): Promise<NexoBinding[]> {
  if (t.backend === "demo") {
    return [...mem.bindings.values()]
      .filter((b) => b.workspace_id === t.workspaceId && (!nexoId || b.nexo_id === nexoId))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  let query = getSupabaseAdmin().from("nexo_bindings").select("*").eq("workspace_id", t.workspaceId);
  if (nexoId) query = query.eq("nexo_id", nexoId);
  const { data, error } = await query.order("created_at", { ascending: true }).limit(500);
  if (error) fail("list_bindings", error);
  return ((data ?? []) as Row[]).map(rowToBinding);
}

export interface CreateBindingsInput {
  nexoId: string;
  installId: string;
  connectorId: string;
  /** One binding per channel (`channel:<id>`); empty = the whole install (`*`). */
  channels: string[];
  scope?: Record<string, unknown>;
  mode: NexoBindingMode;
  createdBy: string | null;
}

/** The scope key a channel binds under. Routing looks up `channel:<id>` first, then `*`. */
export function channelScopeKey(channel: string): string {
  return `channel:${channel}`;
}

/**
 * Bind an install (or some of its channels) to a Nexo. Idempotent for the
 * same Nexo (the mode is updated); throws `NexoConflictError("scope_owned")`
 * when another Nexo already owns one of the keys, without writing anything.
 */
export async function createBindings(t: NexoTarget, input: CreateBindingsInput): Promise<NexoBinding[]> {
  const channels = [...new Set(input.channels.map((c) => c.trim()).filter(Boolean))];
  const wanted = channels.length > 0
    ? channels.map((c) => ({ scope_key: channelScopeKey(c), scope: { ...(input.scope ?? {}), channels: [c] } }))
    : [{ scope_key: "*", scope: { ...(input.scope ?? {}) } }];
  const keys = wanted.map((w) => w.scope_key);

  const existing = await bindingsForKeys(t, input.installId, keys);
  const foreign = existing.filter((b) => b.nexo_id !== input.nexoId);
  if (foreign.length > 0) {
    throw new NexoConflictError(
      "scope_owned",
      `already bound to another Nexo: ${foreign.map((b) => b.scope_key).join(", ")}`,
    );
  }

  if (t.backend === "demo") {
    const out: NexoBinding[] = [];
    for (const w of wanted) {
      const mine = existing.find((b) => b.scope_key === w.scope_key);
      const binding: NexoBinding = mine
        ? { ...mine, mode: input.mode, scope: w.scope }
        : {
            id: randomUUID(),
            nexo_id: input.nexoId,
            workspace_id: t.workspaceId,
            install_id: input.installId,
            connector_id: input.connectorId,
            scope_key: w.scope_key,
            scope: w.scope,
            mode: input.mode,
            created_by: input.createdBy,
            created_at: now(),
          };
      mem.bindings.set(binding.id, binding);
      out.push(binding);
    }
    return out;
  }

  const { data, error } = await getSupabaseAdmin()
    .from("nexo_bindings")
    .upsert(
      wanted.map((w) => ({
        nexo_id: input.nexoId,
        workspace_id: t.workspaceId,
        install_id: input.installId,
        connector_id: input.connectorId,
        scope_key: w.scope_key,
        scope: w.scope,
        mode: input.mode,
        created_by: input.createdBy,
      })),
      { onConflict: "install_id,scope_key" },
    )
    .select("*");
  if (error) fail("create_bindings", error);
  const rows = ((data ?? []) as Row[]).map(rowToBinding);
  // The pre-check above is not a lock: if another Nexo took a key in between,
  // the upsert just moved it here. Say so instead of stealing it silently.
  const stolen = rows.filter((b) => b.nexo_id !== input.nexoId);
  if (stolen.length > 0) throw new NexoConflictError("scope_owned");
  return rows;
}

async function bindingsForKeys(t: NexoTarget, installId: string, keys: string[]): Promise<NexoBinding[]> {
  if (t.backend === "demo") {
    return [...mem.bindings.values()].filter((b) => b.install_id === installId && keys.includes(b.scope_key));
  }
  const { data, error } = await getSupabaseAdmin()
    .from("nexo_bindings")
    .select("*")
    .eq("workspace_id", t.workspaceId)
    .eq("install_id", installId)
    .in("scope_key", keys);
  if (error) fail("bindings_for_keys", error);
  return ((data ?? []) as Row[]).map(rowToBinding);
}

export async function deleteBinding(t: NexoTarget, nexoId: string, bindingId: string): Promise<boolean> {
  if (t.backend === "demo") {
    const b = mem.bindings.get(bindingId);
    if (!b || b.workspace_id !== t.workspaceId || b.nexo_id !== nexoId) return false;
    mem.bindings.delete(bindingId);
    return true;
  }
  if (!UUID.test(bindingId)) return false;
  const { data, error } = await getSupabaseAdmin()
    .from("nexo_bindings")
    .delete()
    .eq("workspace_id", t.workspaceId)
    .eq("nexo_id", nexoId)
    .eq("id", bindingId)
    .select("id");
  if (error) fail("delete_binding", error);
  return (data ?? []).length > 0;
}

/**
 * The binding that owns an inbound event: the first of `scopeKeys` that is
 * bound on this install (callers pass the most specific first, e.g.
 * `["channel:C123", "*"]`). Null = nobody owns it; route to the general Nexo.
 */
export async function findBindingForEvent(
  t: NexoTarget,
  installId: string,
  scopeKeys: string[],
): Promise<NexoBinding | null> {
  if (scopeKeys.length === 0) return null;
  const found = await bindingsForKeys(t, installId, scopeKeys);
  for (const key of scopeKeys) {
    const hit = found.find((b) => b.scope_key === key);
    if (hit) return hit;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Runs                                                                      */
/* -------------------------------------------------------------------------- */

/** Open a run in `running`. Close it with `finishRun`. */
export async function createRun(t: NexoTarget, input: CreateRunInput): Promise<NexoRun> {
  if (t.backend === "demo") {
    const run: NexoRun = {
      id: randomUUID(),
      nexo_id: input.nexoId,
      workspace_id: t.workspaceId,
      trigger: input.trigger,
      status: "running",
      input: input.input ?? {},
      output_md: null,
      steps: [],
      usage: {},
      error: null,
      started_at: now(),
      finished_at: null,
    };
    mem.runs.set(run.id, run);
    return run;
  }
  const { data, error } = await getSupabaseAdmin()
    .from("nexo_runs")
    .insert({
      nexo_id: input.nexoId,
      workspace_id: t.workspaceId,
      trigger: input.trigger,
      status: "running",
      input: input.input ?? {},
    })
    .select("*")
    .single();
  if (error) fail("create_run", error);
  return rowToRun(data as Row);
}

/**
 * Close a run and stamp the Nexo's `last_run_at`. Only a `running` run is
 * closed; finishing one twice returns null the second time.
 */
export async function finishRun(t: NexoTarget, runId: string, input: FinishRunInput): Promise<NexoRun | null> {
  const finishedAt = now();
  const patch = {
    status: input.status,
    output_md: input.output_md ?? null,
    steps: input.steps ?? [],
    usage: input.usage ?? {},
    error: input.error ?? null,
    finished_at: finishedAt,
  };
  let run: NexoRun | null;
  if (t.backend === "demo") {
    const current = mem.runs.get(runId);
    if (!current || current.workspace_id !== t.workspaceId || current.status !== "running") return null;
    run = { ...current, ...patch };
    mem.runs.set(runId, run);
  } else {
    const { data, error } = await getSupabaseAdmin()
      .from("nexo_runs")
      .update(patch)
      .eq("workspace_id", t.workspaceId)
      .eq("id", runId)
      .eq("status", "running")
      .select("*")
      .maybeSingle();
    if (error) fail("finish_run", error);
    run = data ? rowToRun(data as Row) : null;
  }
  if (run) await updateNexoRow(t, run.nexo_id, { last_run_at: finishedAt });
  return run;
}

export async function getRun(t: NexoTarget, runId: string): Promise<NexoRun | null> {
  if (t.backend === "demo") {
    const r = mem.runs.get(runId);
    return r && r.workspace_id === t.workspaceId ? r : null;
  }
  if (!UUID.test(runId)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("nexo_runs")
    .select("*")
    .eq("workspace_id", t.workspaceId)
    .eq("id", runId)
    .maybeSingle();
  if (error) fail("get_run", error);
  return data ? rowToRun(data as Row) : null;
}

/** Newest first. */
export async function listRuns(
  t: NexoTarget,
  opts: { nexoId?: string; limit?: number } = {},
): Promise<NexoRun[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (t.backend === "demo") {
    return [...mem.runs.values()]
      .filter((r) => r.workspace_id === t.workspaceId && (!opts.nexoId || r.nexo_id === opts.nexoId))
      .sort(byNewest((r) => r.started_at))
      .slice(0, limit);
  }
  let query = getSupabaseAdmin().from("nexo_runs").select("*").eq("workspace_id", t.workspaceId);
  if (opts.nexoId) query = query.eq("nexo_id", opts.nexoId);
  const { data, error } = await query.order("started_at", { ascending: false }).limit(limit);
  if (error) fail("list_runs", error);
  return ((data ?? []) as Row[]).map(rowToRun);
}

/* -------------------------------------------------------------------------- */
/*  Inbox                                                                     */
/* -------------------------------------------------------------------------- */

export async function createInboxItem(t: NexoTarget, input: CreateInboxItemInput): Promise<NexoInboxItem> {
  const title = input.title.trim().slice(0, 200) || "Sin título";
  if (t.backend === "demo") {
    const at = now();
    const item: NexoInboxItem = {
      id: randomUUID(),
      workspace_id: t.workspaceId,
      nexo_id: input.nexoId,
      run_id: input.runId ?? null,
      kind: input.kind,
      title,
      body_md: input.body_md ?? "",
      payload: input.payload ?? {},
      status: "open",
      resolved_by: null,
      resolved_at: null,
      created_at: at,
      updated_at: at,
    };
    mem.inbox.set(item.id, item);
    return item;
  }
  const { data, error } = await getSupabaseAdmin()
    .from("nexo_inbox")
    .insert({
      workspace_id: t.workspaceId,
      nexo_id: input.nexoId,
      run_id: input.runId ?? null,
      kind: input.kind,
      title,
      body_md: input.body_md ?? "",
      payload: input.payload ?? {},
    })
    .select("*")
    .single();
  if (error) fail("create_inbox", error);
  return rowToInbox(data as Row);
}

export async function getInboxItem(t: NexoTarget, id: string): Promise<NexoInboxItem | null> {
  if (t.backend === "demo") {
    const i = mem.inbox.get(id);
    return i && i.workspace_id === t.workspaceId ? i : null;
  }
  if (!UUID.test(id)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("nexo_inbox")
    .select("*")
    .eq("workspace_id", t.workspaceId)
    .eq("id", id)
    .maybeSingle();
  if (error) fail("get_inbox", error);
  return data ? rowToInbox(data as Row) : null;
}

/** Newest first. */
export async function listInbox(
  t: NexoTarget,
  opts: { nexoId?: string; status?: NexoInboxStatus; limit?: number } = {},
): Promise<NexoInboxItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  if (t.backend === "demo") {
    return [...mem.inbox.values()]
      .filter(
        (i) =>
          i.workspace_id === t.workspaceId &&
          (!opts.nexoId || i.nexo_id === opts.nexoId) &&
          (!opts.status || i.status === opts.status),
      )
      .sort(byNewest((i) => i.created_at))
      .slice(0, limit);
  }
  let query = getSupabaseAdmin().from("nexo_inbox").select("*").eq("workspace_id", t.workspaceId);
  if (opts.nexoId) query = query.eq("nexo_id", opts.nexoId);
  if (opts.status) query = query.eq("status", opts.status);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) fail("list_inbox", error);
  return ((data ?? []) as Row[]).map(rowToInbox);
}

/** Open items per Nexo in the workspace (absent = 0). */
export async function countOpenInbox(t: NexoTarget): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let nexoIds: string[];
  if (t.backend === "demo") {
    nexoIds = [...mem.inbox.values()]
      .filter((i) => i.workspace_id === t.workspaceId && i.status === "open")
      .map((i) => i.nexo_id);
  } else {
    const { data, error } = await getSupabaseAdmin()
      .from("nexo_inbox")
      .select("nexo_id")
      .eq("workspace_id", t.workspaceId)
      .eq("status", "open")
      .limit(5000);
    if (error) fail("count_inbox", error);
    nexoIds = ((data ?? []) as Row[]).map((r) => String(r.nexo_id));
  }
  for (const id of nexoIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/**
 * Move an `open` item to its final status. Compare-and-set on `open`: null
 * when the item does not exist or someone resolved it first. State only —
 * sending an approved draft is the caller's job, done after this succeeds.
 */
export async function resolveInboxItem(
  t: NexoTarget,
  id: string,
  input: ResolveInboxItemInput,
): Promise<NexoInboxItem | null> {
  const current = await getInboxItem(t, id);
  if (!current || current.status !== "open") return null;
  const patch = {
    status: input.status,
    resolved_by: input.resolvedBy,
    resolved_at: now(),
    payload: { ...current.payload, ...(input.payload ?? {}) },
  };
  if (t.backend === "demo") {
    const next: NexoInboxItem = { ...current, ...patch, updated_at: patch.resolved_at };
    mem.inbox.set(id, next);
    return next;
  }
  const { data, error } = await getSupabaseAdmin()
    .from("nexo_inbox")
    .update(patch)
    .eq("workspace_id", t.workspaceId)
    .eq("id", id)
    .eq("status", "open")
    .select("*")
    .maybeSingle();
  if (error) fail("resolve_inbox", error);
  return data ? rowToInbox(data as Row) : null;
}

/* -------------------------------------------------------------------------- */
/*  Windows                                                                   */
/* -------------------------------------------------------------------------- */

function compactEvent(event: NexoWindowEvent): NexoWindowEvent {
  return {
    ...event,
    ts: String(event.ts),
    author: String(event.author ?? "").slice(0, 200),
    text: String(event.text ?? "").slice(0, WINDOW_DEFAULTS.maxEventText),
  };
}

/**
 * Add one inbound message to the Nexo's open window for `sourceKey`, opening
 * it if there is none, and reschedule its flush: `last_at + quiet` normally,
 * now when the message or span cap is hit. Atomic in Postgres
 * (`append_nexo_window_event`).
 */
export async function appendWindowEvent(t: NexoTarget, input: AppendWindowEventInput): Promise<NexoWindow> {
  const quiet = input.quietSeconds ?? WINDOW_DEFAULTS.quietSeconds;
  const maxMessages = input.maxMessages ?? WINDOW_DEFAULTS.maxMessages;
  const maxSpan = input.maxSpanSeconds ?? WINDOW_DEFAULTS.maxSpanSeconds;
  const event = compactEvent(input.event);

  if (t.backend === "demo") {
    const at = new Date();
    const iso = at.toISOString();
    const open = [...mem.windows.values()].find(
      (w) => w.nexo_id === input.nexoId && w.source_key === input.sourceKey && w.state === "collecting",
    );
    if (!open) {
      const w: NexoWindow = {
        id: randomUUID(),
        workspace_id: t.workspaceId,
        nexo_id: input.nexoId,
        binding_id: input.bindingId,
        source_key: input.sourceKey,
        events: [event],
        message_count: 1,
        first_at: iso,
        last_at: iso,
        flush_after: maxMessages <= 1 ? iso : new Date(at.getTime() + quiet * 1000).toISOString(),
        state: "collecting",
        claimed_at: null,
        flushed_at: null,
        created_at: iso,
      };
      mem.windows.set(w.id, w);
      return w;
    }
    const count = open.message_count + 1;
    const capped = count >= maxMessages || at.getTime() - Date.parse(open.first_at) >= maxSpan * 1000;
    const next: NexoWindow = {
      ...open,
      binding_id: input.bindingId ?? open.binding_id,
      // Same ceiling as `append_nexo_window_event` (0096).
      events: open.events.length >= Math.max(maxMessages, 200) ? open.events : [...open.events, event],
      message_count: count,
      last_at: iso,
      flush_after: capped ? iso : new Date(at.getTime() + quiet * 1000).toISOString(),
    };
    mem.windows.set(next.id, next);
    return next;
  }

  const { data, error } = await getSupabaseAdmin().rpc("append_nexo_window_event", {
    p_workspace_id: t.workspaceId,
    p_nexo_id: input.nexoId,
    p_binding_id: input.bindingId,
    p_source_key: input.sourceKey,
    p_event: event,
    p_quiet_seconds: quiet,
    p_max_messages: maxMessages,
    p_max_span_seconds: maxSpan,
  });
  if (error) fail("append_window", error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("nexos.append_window: no row returned");
  return rowToWindow(row as Row);
}

/**
 * Claim every window due for flushing, across workspaces: `collecting` ones
 * past `flush_after`, and `flushing` ones abandoned longer than
 * `staleSeconds` (a worker died mid-flush). Claimed windows move to
 * `flushing`; finish each with `markWindowFlushed`.
 */
export async function claimDueWindows(
  opts: { now?: Date; limit?: number; staleSeconds?: number; backend?: StorageBackend } = {},
): Promise<NexoWindow[]> {
  const at = opts.now ?? new Date();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const stale = opts.staleSeconds ?? WINDOW_DEFAULTS.staleSeconds;
  if ((opts.backend ?? defaultBackend()) === "demo") {
    const iso = at.toISOString();
    const staleBefore = at.getTime() - stale * 1000;
    const due = [...mem.windows.values()]
      .filter(
        (w) =>
          (w.state === "collecting" && w.flush_after <= iso) ||
          (w.state === "flushing" && w.claimed_at !== null && Date.parse(w.claimed_at) < staleBefore),
      )
      .sort((a, b) => a.flush_after.localeCompare(b.flush_after))
      .slice(0, limit);
    return due.map((w) => {
      const claimed: NexoWindow = { ...w, state: "flushing", claimed_at: iso };
      mem.windows.set(w.id, claimed);
      return claimed;
    });
  }
  const { data, error } = await getSupabaseAdmin().rpc("claim_due_nexo_windows", {
    p_now: at.toISOString(),
    p_limit: limit,
    p_stale_seconds: stale,
  });
  if (error) fail("claim_windows", error);
  return ((data ?? []) as Row[]).map(rowToWindow);
}

/** Close a claimed window. Only a `flushing` window moves; returns whether it did. */
export async function markWindowFlushed(
  windowId: string,
  opts: { backend?: StorageBackend } = {},
): Promise<boolean> {
  const at = now();
  if ((opts.backend ?? defaultBackend()) === "demo") {
    const w = mem.windows.get(windowId);
    if (!w || w.state !== "flushing") return false;
    mem.windows.set(windowId, { ...w, state: "flushed", flushed_at: at });
    return true;
  }
  const { data, error } = await getSupabaseAdmin()
    .from("nexo_windows")
    .update({ state: "flushed", flushed_at: at })
    .eq("id", windowId)
    .eq("state", "flushing")
    .select("id");
  if (error) fail("mark_flushed", error);
  return (data ?? []).length > 0;
}

/** Windows of a Nexo, newest first (diagnostics and the activity tab). */
export async function listWindows(
  t: NexoTarget,
  opts: { nexoId?: string; state?: NexoWindow["state"]; limit?: number } = {},
): Promise<NexoWindow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (t.backend === "demo") {
    return [...mem.windows.values()]
      .filter(
        (w) =>
          w.workspace_id === t.workspaceId &&
          (!opts.nexoId || w.nexo_id === opts.nexoId) &&
          (!opts.state || w.state === opts.state),
      )
      .sort(byNewest((w) => w.last_at))
      .slice(0, limit);
  }
  let query = getSupabaseAdmin().from("nexo_windows").select("*").eq("workspace_id", t.workspaceId);
  if (opts.nexoId) query = query.eq("nexo_id", opts.nexoId);
  if (opts.state) query = query.eq("state", opts.state);
  const { data, error } = await query.order("last_at", { ascending: false }).limit(limit);
  if (error) fail("list_windows", error);
  return ((data ?? []) as Row[]).map(rowToWindow);
}

/* -------------------------------------------------------------------------- */
/*  Chat sessions                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Chat sessions of one Nexo, most recently active first. The general Nexo's
 * sessions are the ones with `nexo_id is null` (the history from before
 * Nexos existed). `userId` narrows to one person's conversations, which is
 * the same boundary `/api/nexo/conversations` keeps. The demo backend keeps
 * no chat history.
 */
export async function listNexoSessions(
  t: NexoTarget,
  nexo: Pick<Nexo, "id" | "is_general">,
  opts: { userId?: string | null; limit?: number } = {},
): Promise<NexoSession[]> {
  if (t.backend === "demo") return [];
  let query = getSupabaseAdmin()
    .from("chat_sessions")
    .select("id,title,user_id,created_at,updated_at")
    .eq("workspace_id", t.workspaceId);
  query = nexo.is_general ? query.is("nexo_id", null) : query.eq("nexo_id", nexo.id);
  if (opts.userId) query = query.eq("user_id", opts.userId);
  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 200));
  if (error) fail("list_sessions", error);
  return ((data ?? []) as Row[]).map((row) => ({
    id: String(row.id),
    title: str(row.title),
    user_id: str(row.user_id),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? row.created_at ?? ""),
  }));
}
