/**
 * Workspace catalog — cross-workspace operations (list, create) that the
 * per-workspace Storage abstraction does not handle. Routes go through
 * this so creating a workspace lands in Supabase when configured, or in
 * the in-memory demo-store when not.
 */
import { syncGrantFromMembership } from "@/lib/auth/grant-sync";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Workspace } from "@bcontext-dev/contract/types";
import {
  createWorkspace as demoCreate,
  listWorkspaces as demoList,
} from "@/lib/demo-store";
import { baseSlug, disambiguate } from "@/lib/slugs";
import { supabaseConfigured } from "@/lib/env";

export interface CreateWorkspaceInput {
  /** Slug or id of the organization it goes into. Required outside demo mode. */
  organization?: string;
  name: string;
  /** Demo storage only — with Supabase the slug is always generated. */
  slug?: string;
  description?: string | null;
}

/**
 * List workspaces visible to a user. When Supabase is configured we look
 * up membership rows; otherwise we return the in-memory demo workspaces.
 */
export async function listWorkspacesForUser(
  userId: string | null,
): Promise<Workspace[]> {
  if (!supabaseConfigured()) return demoList();
  const admin = getSupabaseAdmin();
  if (!userId) return [];
  // Two ways in, unioned: a membership in the workspace itself, or being an
  // owner/admin of the organization that holds it. The second is the point
  // of an organization — whoever administers it does not have to add
  // themselves to every project inside it, one by one, to see that they
  // exist. Editors and viewers of the org get nothing here: their access is
  // granted workspace by workspace.
  const [{ data: memberships }, { data: orgRoles }] = await Promise.all([
    admin.from("memberships").select("workspace_id").eq("user_id", userId),
    admin
      .from("organization_memberships")
      .select("organization_id, role")
      .eq("user_id", userId)
      .in("role", ["owner", "admin"]),
  ]);
  const ids = (memberships ?? []).map(
    (m: { workspace_id: string }) => m.workspace_id,
  );
  const adminOrgIds = (orgRoles ?? []).map(
    (m: { organization_id: string }) => m.organization_id,
  );
  if (ids.length === 0 && adminOrgIds.length === 0) return [];

  const byId = ids.length
    ? admin.from("workspaces").select("*").in("id", ids)
    : null;
  const byOrg = adminOrgIds.length
    ? admin.from("workspaces").select("*").in("organization_id", adminOrgIds)
    : null;
  const [mine, administered] = await Promise.all([
    byId ? byId : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    byOrg ? byOrg : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  const rows = new Map<string, Record<string, unknown>>();
  for (const row of [...(mine.data ?? []), ...(administered.data ?? [])]) {
    rows.set(row.id as string, row);
  }
  return [...rows.values()]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(rowToWorkspace);
}

export class WorkspaceCreateError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "WorkspaceCreateError";
  }
}

/**
 * Create an empty workspace inside an organization the caller administers.
 *
 * A workspace always goes into an organization that already exists, and only
 * an owner or admin of it may put one there. Minting an organization per
 * workspace would make "organization" mean nothing: it would group nothing,
 * be shared with nobody and could not be administered.
 *
 * The slug is derived from the name and disambiguated with a number — never
 * supplied by the caller — because it is an address, not a label.
 */
export async function createWorkspaceForUser(
  userId: string | null,
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  if (!supabaseConfigured() || !userId) {
    // Demo path — keep behaviour identical to before.
    return demoCreate({
      name: input.name,
      slug: input.slug,
      description: input.description ?? undefined,
    });
  }
  const name = input.name.trim();
  if (!name) {
    throw new WorkspaceCreateError(400, "invalid_name", "The workspace needs a name.");
  }

  const admin = getSupabaseAdmin();
  const org = await resolveAdministeredOrg(userId, input.organization);
  const slug = await freeWorkspaceSlug(org.id, name);

  const { data: ws, error } = await admin
    .from("workspaces")
    .insert({
      organization_id: org.id,
      slug,
      name,
      description: input.description ?? null,
    })
    .select("*")
    .single();
  if (error || !ws) {
    throw new Error(`createWorkspace: ${error?.message ?? "no row returned"}`);
  }

  // The creator's own access, written at the same moment as the row: a
  // membership (what node RLS gates on) and the grant that is authoritative.
  await admin.from("memberships").insert({
    user_id: userId,
    workspace_id: ws.id,
    role: "owner",
  });
  await syncGrantFromMembership(ws.id, userId, "owner", { reinstate: true });

  return rowToWorkspace(ws);
}

/**
 * The organization a new workspace goes into, refused unless the caller
 * administers it. `organization` is a slug or an id — the web sends the slug
 * it already shows, an agent may hold the id.
 */
async function resolveAdministeredOrg(
  userId: string,
  organization: string | undefined,
): Promise<{ id: string; slug: string; name: string }> {
  const raw = (organization ?? "").trim().toLowerCase();
  if (!raw) {
    throw new WorkspaceCreateError(
      400,
      "organization_required",
      "Say which organization the workspace belongs to.",
    );
  }
  const admin = getSupabaseAdmin();
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw);
  const { data: org } = await admin
    .from("organizations")
    .select("id, slug, name")
    .eq(isUuid ? "id" : "slug", raw)
    .maybeSingle();
  // A 404 for an organization the caller cannot administer either: whether
  // it exists is not something an outsider gets to learn from this route.
  if (!org) throw new WorkspaceCreateError(404, "organization_not_found");

  const { data: membership } = await admin
    .from("organization_memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("organization_id", org.id as string)
    .maybeSingle();
  const role = membership?.role as string | undefined;
  if (role !== "owner" && role !== "admin") {
    throw new WorkspaceCreateError(
      403,
      "not_org_admin",
      "Only an owner or admin of the organization can create a workspace in it.",
    );
  }
  return org as { id: string; slug: string; name: string };
}

/** The first free spelling of the name inside this organization. */
async function freeWorkspaceSlug(orgId: string, name: string): Promise<string> {
  const admin = getSupabaseAdmin();
  const base = baseSlug(name, "workspace");
  const { data } = await admin
    .from("workspaces")
    .select("slug")
    .eq("organization_id", orgId);
  return disambiguate(base, (data ?? []).map((r: { slug: string }) => r.slug));
}

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    github_repo: (row.github_repo as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.created_at as string,
  };
}
