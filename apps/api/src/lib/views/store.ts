/**
 * CRUD for saved views over both backends: `saved_views` in Postgres, an
 * in-memory map for demo workspaces. Callers are the `/api/views/*` routes
 * (via `views/http.ts`) and the MCP `views`/`views_write` tools.
 *
 * Every function takes the `ViewPrincipal` and enforces visibility and
 * ownership itself — private views are invisible to non-admins, system views are
 * read-only, and updates carry an `expected_version` so two editors cannot
 * silently overwrite each other (`ViewConflictError` → 409). Writes broadcast
 * a `viewChanged` event so open sidebars refresh.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Storage } from "@/lib/storage";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { normalizeViewPresentation, normalizeViewQuery } from "@bcontext-dev/contract/views/schema";
import { systemViewSeeds } from "./seeds";
import type { SavedView, ViewPrincipal, ViewVisibility } from "@bcontext-dev/contract/views/types";

export class ViewNotFoundError extends Error {}
export class ViewForbiddenError extends Error {}
export class ViewConflictError extends Error {
  constructor(public readonly currentVersion: number, public readonly expectedVersion: number) {
    super(`view version is ${currentVersion}, expected ${expectedVersion}`);
  }
}

export interface CreateViewInput {
  name: string;
  description?: string | null;
  visibility?: ViewVisibility;
  query: unknown;
  presentation: unknown;
}

export interface UpdateViewInput {
  expected_version: number;
  name?: string;
  description?: string | null;
  visibility?: ViewVisibility;
  query?: unknown;
  presentation?: unknown;
}

type StoredView = SavedView & { position?: number };
const demoViews = new Map<string, StoredView[]>();

/** System views first, then custom ones by position — the sidebar order. */
export async function listViews(storage: Storage, principal: ViewPrincipal): Promise<SavedView[]> {
  const rows = await allViews(storage);
  return rows.filter((view) => canRead(view, principal)).map(stripPosition);
}

/** A view the principal may not read is reported as missing, not forbidden. */
export async function getView(storage: Storage, principal: ViewPrincipal, id: string): Promise<SavedView> {
  const view = (await allViews(storage)).find((row) => row.id === id);
  if (!view || !canRead(view, principal)) throw new ViewNotFoundError("view not found");
  return stripPosition(view);
}

export async function createView(storage: Storage, principal: ViewPrincipal, input: CreateViewInput): Promise<SavedView> {
  requireWriter(principal);
  const now = new Date().toISOString();
  const rows = await allViews(storage);
  const slug = uniqueSlug(input.name, rows);
  const owner = ownerColumns(principal);
  const payload = {
    workspace_id: storage.workspace.id,
    system_key: null,
    name: input.name.trim(),
    slug,
    description: input.description?.trim() || null,
    kind: "custom" as const,
    visibility: input.visibility ?? "private",
    ...owner,
    query: normalizeViewQuery(input.query),
    presentation: normalizeViewPresentation(input.presentation),
    schema_version: 1,
    version: 1,
  };
  if (storage.backend === "demo") {
    const view: StoredView = { ...payload, id: crypto.randomUUID(), created_at: now, updated_at: now, position: rows.length * 10 };
    demoRows(storage.workspace.id).push(view);
    await wsBroadcast.viewChanged(storage.workspace.id, view.id, "created", principal.id);
    return stripPosition(view);
  }
  const { data, error } = await getSupabaseAdmin().from("saved_views").insert(payload).select("*").single();
  if (error) throw new Error(`createView: ${error.message}`);
  const created = parseRow(data);
  await wsBroadcast.viewChanged(storage.workspace.id, created.id, "created", principal.id);
  return created;
}

export async function duplicateView(storage: Storage, principal: ViewPrincipal, id: string, name?: string): Promise<SavedView> {
  const source = await getView(storage, principal, id);
  return createView(storage, principal, {
    name: name?.trim() || `${source.name} copy`,
    description: source.description,
    visibility: "private",
    query: source.query,
    presentation: source.presentation,
  });
}

export async function updateView(storage: Storage, principal: ViewPrincipal, id: string, input: UpdateViewInput): Promise<SavedView> {
  requireWriter(principal);
  const current = await getView(storage, principal, id);
  requireOwner(current, principal);
  if (current.version !== input.expected_version) throw new ViewConflictError(current.version, input.expected_version);
  const rows = await allViews(storage);
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    patch.name = input.name.trim();
    patch.slug = uniqueSlug(input.name, rows.filter((view) => view.id !== id));
  }
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.visibility !== undefined) patch.visibility = input.visibility;
  if (input.query !== undefined) patch.query = normalizeViewQuery(input.query);
  if (input.presentation !== undefined) patch.presentation = normalizeViewPresentation(input.presentation);
  if (Object.keys(patch).length === 0) return current;

  if (storage.backend === "demo") {
    const stored = demoRows(storage.workspace.id).find((view) => view.id === id)!;
    Object.assign(stored, patch, { version: stored.version + 1, updated_at: new Date().toISOString() });
    await wsBroadcast.viewChanged(storage.workspace.id, stored.id, "updated", principal.id);
    return stripPosition(stored);
  }
  const { data, error } = await getSupabaseAdmin().from("saved_views").update(patch)
    .eq("workspace_id", storage.workspace.id).eq("id", id).eq("kind", "custom")
    .eq("version", input.expected_version).select("*").maybeSingle();
  if (error) throw new Error(`updateView: ${error.message}`);
  if (!data) {
    const fresh = await getView(storage, principal, id);
    throw new ViewConflictError(fresh.version, input.expected_version);
  }
  const updated = parseRow(data);
  await wsBroadcast.viewChanged(storage.workspace.id, updated.id, "updated", principal.id);
  return updated;
}

export async function deleteView(storage: Storage, principal: ViewPrincipal, id: string, expectedVersion?: number): Promise<void> {
  requireWriter(principal);
  const current = await getView(storage, principal, id);
  requireOwner(current, principal);
  if (expectedVersion !== undefined && current.version !== expectedVersion) throw new ViewConflictError(current.version, expectedVersion);
  if (storage.backend === "demo") {
    demoViews.set(storage.workspace.id, demoRows(storage.workspace.id).filter((view) => view.id !== id));
    await wsBroadcast.viewChanged(storage.workspace.id, id, "deleted", principal.id);
    return;
  }
  let query = getSupabaseAdmin().from("saved_views").delete().eq("workspace_id", storage.workspace.id).eq("id", id).eq("kind", "custom");
  if (expectedVersion !== undefined) query = query.eq("version", expectedVersion);
  const { data, error } = await query.select("id");
  if (error) throw new Error(`deleteView: ${error.message}`);
  if (!data || data.length === 0) throw new ViewConflictError(current.version, expectedVersion ?? current.version);
  await wsBroadcast.viewChanged(storage.workspace.id, id, "deleted", principal.id);
}

function requireWriter(principal: ViewPrincipal) {
  if (!principal.canWrite) throw new ViewForbiddenError("editor role or nodes:write scope required");
}

function requireOwner(view: SavedView, principal: ViewPrincipal) {
  if (view.kind === "system") throw new ViewForbiddenError("system views are immutable");
  if (principal.isAdmin) return;
  const owned = principal.type === "user" ? view.owner_id === principal.id : view.owner_token_id === principal.id;
  if (!owned) throw new ViewForbiddenError("only the view owner or a workspace admin may change it");
}

function canRead(view: SavedView, principal: ViewPrincipal): boolean {
  if (view.kind === "system" || view.visibility === "workspace" || principal.isAdmin) return true;
  return principal.type === "user" ? view.owner_id === principal.id : view.owner_token_id === principal.id;
}

function ownerColumns(principal: ViewPrincipal) {
  return principal.type === "user"
    ? { owner_id: principal.id, owner_token_id: null }
    : { owner_id: null, owner_token_id: principal.id };
}

const RETIRED_SYSTEM_VIEW_KEYS = new Set(["decisions", "tags"]);

async function allViews(storage: Storage): Promise<StoredView[]> {
  if (storage.backend === "demo") return demoRows(storage.workspace.id);
  const { data, error } = await getSupabaseAdmin().from("saved_views").select("*")
    .eq("workspace_id", storage.workspace.id).order("kind", { ascending: false }).order("position").order("name");
  if (error) throw new Error(`listViews: ${error.message}`);
  // Retired system views may still carry a row in Postgres for workspaces
  // seeded before they were dropped — hide them without a data migration.
  // Decisions and Tags went 2026-09-08 (Tags folded into the Brain graph as
  // a focus mode, Decisions was never used). Roadmap came back 2026-09-11 as
  // the goals roadmap; migration 0090 rewrote the old timeline rows.
  return (data ?? []).map(parseRow).filter((view: StoredView) =>
    view.system_key === null || !RETIRED_SYSTEM_VIEW_KEYS.has(view.system_key),
  );
}

function demoRows(workspaceId: string): StoredView[] {
  let rows = demoViews.get(workspaceId);
  if (!rows) {
    rows = systemViewSeeds(workspaceId);
    demoViews.set(workspaceId, rows);
  }
  return rows;
}

function parseRow(row: Record<string, unknown>): StoredView {
  const parsed: StoredView = {
    ...(row as unknown as SavedView),
    query: normalizeViewQuery(row.query),
    presentation: normalizeViewPresentation(row.presentation),
    version: Number(row.version),
    schema_version: Number(row.schema_version),
    position: Number(row.position ?? 0),
  };
  return parsed;
}

function stripPosition(view: StoredView): SavedView {
  const { position: _position, ...result } = view;
  return structuredClone(result);
}

function uniqueSlug(name: string, rows: StoredView[]): string {
  const base = name.trim().toLocaleLowerCase("en-US").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 140) || "view";
  const used = new Set(rows.map((view) => view.slug));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix++) if (!used.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
  throw new Error("unable to allocate view slug");
}

export function resetDemoViewsForTests(): void {
  demoViews.clear();
}
