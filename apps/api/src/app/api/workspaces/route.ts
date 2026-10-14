/**
 * The caller's workspaces — the hub page and the "which slug am I" question
 * an agent asks first (MCP has `list_workspaces`).
 *
 *   GET  /api/workspaces[?stats=1]   what `gate` lets this principal see
 *   POST /api/workspaces             { organization, name, description? }
 *
 * `gate` accepts a session or a bearer token; creating is delegated to
 * `createWorkspaceForUser`, which decides whether the person may create inside that organization.
 * Without Supabase both read from the in-memory demo store.
 */
import { z } from "zod";
import { record as recordActivity } from "@/lib/activity";
import { readJsonBody } from "@/lib/parse-json";
import { gate } from "@/lib/auth/require";
import {
  createWorkspaceForUser,
  listWorkspacesForUser,
} from "@/lib/workspaces/registry";
import { withRoute } from "@/lib/route";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { listNodes as demoListNodes } from "@/lib/demo-store";
import type { Workspace } from "@bcontext-dev/contract/types";
import type {
  OrganizationCard,
  WorkspaceCard,
  WorkspaceOrgRef,
  WorkspaceRole,
} from "@bcontext-dev/contract/workspaces";
import type { InviteRole } from "@bcontext-dev/contract/workspaces";
import { WorkspaceCreateError } from "@/lib/workspaces/registry";

/**
 * `?stats=1` returns each workspace as a hub card: the caller's role and the
 * counts the card shows. Opt-in, because it is four more queries that an
 * agent discovering its slug has no use for.
 */
export const GET = withRoute(async (req: Request) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  const userId = gated.kind === "user" ? gated.userId : null;
  const workspaces = await listWorkspacesForUser(userId);
  if (new URL(req.url).searchParams.get("stats") !== "1") {
    return Response.json({ workspaces });
  }
  // The hub groups by organization, so it needs the organizations too — and
  // it needs the ones the caller belongs to even when they hold no workspace
  // yet, or a freshly created company would render as an empty page with no
  // way to put anything in it.
  const [cards, organizations] = await Promise.all([
    withStats(workspaces, userId),
    listOrganizationsForUser(userId, workspaces),
  ]);
  return Response.json({ workspaces: cards, organizations });
});

/** The organizations the caller belongs to, with what they may do in each. */
async function listOrganizationsForUser(
  userId: string | null,
  workspaces: Workspace[],
): Promise<OrganizationCard[]> {
  if (!isSupabaseConfigured() || !userId) {
    // Demo store has no organizations; the hub renders one implicit group.
    const orgIds = [...new Set(workspaces.map((w) => w.organization_id))];
    return orgIds.map((id) => ({
      id,
      slug: "demo",
      name: "Demo",
      role: "owner" as InviteRole,
      workspace_count: workspaces.filter((w) => w.organization_id === id).length,
      member_count: 1,
      can_create_workspace: true,
      can_manage: true,
    }));
  }
  const admin = getSupabaseAdmin();
  const { data: memberships } = await admin
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("user_id", userId);
  const rows = (memberships ?? []) as Array<{ organization_id: string; role: InviteRole }>;
  if (rows.length === 0) return [];
  const orgIds = rows.map((r) => r.organization_id);

  const [{ data: orgs }, { data: allMembers }, { data: allWorkspaces }] = await Promise.all([
    admin.from("organizations").select("id, slug, name").in("id", orgIds),
    admin.from("organization_memberships").select("organization_id").in("organization_id", orgIds),
    admin.from("workspaces").select("id, organization_id").in("organization_id", orgIds),
  ]);
  const byId = new Map(
    ((orgs ?? []) as Array<{ id: string; slug: string; name: string }>).map((o) => [o.id, o]),
  );
  const countIn = (rowsIn: unknown, key: string): number =>
    ((rowsIn ?? []) as Array<{ organization_id: string }>).filter(
      (r) => r.organization_id === key,
    ).length;

  return rows
    .map((m) => {
      const org = byId.get(m.organization_id);
      if (!org) return null;
      const manages = m.role === "owner" || m.role === "admin";
      return {
        id: org.id,
        slug: org.slug,
        name: org.name,
        role: m.role,
        workspace_count: countIn(allWorkspaces, org.id),
        member_count: countIn(allMembers, org.id),
        can_create_workspace: manages,
        can_manage: manages,
      } satisfies OrganizationCard;
    })
    .filter((o): o is OrganizationCard => o !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function withStats(workspaces: Workspace[], userId: string | null): Promise<WorkspaceCard[]> {
  if (workspaces.length === 0) return [];
  if (!isSupabaseConfigured()) {
    // Demo store: one person, no roster, everything is theirs.
    return workspaces.map((w) => {
      const nodes = demoListNodes(w.slug);
      return {
        ...w,
        role: "owner",
        organization: {
          id: w.organization_id,
          slug: "demo",
          name: "Demo",
          role: "owner" as InviteRole,
        },
        member_count: 1,
        open_task_count: nodes.filter((n) => n.kind === "task" && n.status !== "done").length,
        node_count: nodes.length,
        last_activity_at: nodes.reduce((acc, n) => (n.updated_at > acc ? n.updated_at : acc), w.created_at),
      };
    });
  }

  const admin = getSupabaseAdmin();
  const ids = workspaces.map((w) => w.id);
  const orgIds = [...new Set(workspaces.map((w) => w.organization_id))];
  // Mutually independent, so issued together rather than one after another.
  const [
    { data: mine },
    { data: members },
    { data: openTasks },
    { data: nodes },
    { data: activity },
    { data: orgs },
    { data: orgRoles },
  ] = await Promise.all([
      admin.from("memberships").select("workspace_id, role").eq("user_id", userId).in("workspace_id", ids),
      admin.from("memberships").select("workspace_id").in("workspace_id", ids),
      admin.from("nodes").select("workspace_id").in("workspace_id", ids).eq("kind", "task").neq("status", "done"),
      admin.from("nodes").select("workspace_id").in("workspace_id", ids),
      admin
        .from("activity")
        .select("workspace_id, created_at")
        .in("workspace_id", ids)
        .order("created_at", { ascending: false })
        .limit(200),
      admin.from("organizations").select("id, slug, name").in("id", orgIds),
      admin
        .from("organization_memberships")
        .select("organization_id, role")
        .eq("user_id", userId)
        .in("organization_id", orgIds),
    ]);

  const count = (rows: unknown): Map<string, number> => {
    const out = new Map<string, number>();
    for (const r of (rows ?? []) as Array<{ workspace_id: string }>) {
      out.set(r.workspace_id, (out.get(r.workspace_id) ?? 0) + 1);
    }
    return out;
  };
  const role = new Map<string, WorkspaceRole>(
    ((mine ?? []) as Array<{ workspace_id: string; role: WorkspaceRole }>).map((m) => [m.workspace_id, m.role]),
  );
  const memberCount = count(members);
  const taskCount = count(openTasks);
  const nodeCount = count(nodes);
  const lastActivity = new Map<string, string>();
  for (const a of (activity ?? []) as Array<{ workspace_id: string; created_at: string }>) {
    if (!lastActivity.has(a.workspace_id)) lastActivity.set(a.workspace_id, a.created_at);
  }

  const orgById = new Map(
    ((orgs ?? []) as Array<{ id: string; slug: string; name: string }>).map((o) => [o.id, o]),
  );
  const orgRole = new Map(
    ((orgRoles ?? []) as Array<{ organization_id: string; role: InviteRole }>).map((m) => [
      m.organization_id,
      m.role,
    ]),
  );
  const orgRef = (w: Workspace): WorkspaceOrgRef => {
    const org = orgById.get(w.organization_id);
    return {
      id: w.organization_id,
      slug: org?.slug ?? "",
      name: org?.name ?? "",
      role: orgRole.get(w.organization_id) ?? null,
    };
  };

  return workspaces.map((w) => ({
    ...w,
    // Administering the organization is a role in every workspace it holds,
    // even the ones this person never joined — same rule `resolveGrant` applies.
    role: role.get(w.id) ?? orgRole.get(w.organization_id) ?? "viewer",
    organization: orgRef(w),
    member_count: memberCount.get(w.id) ?? 1,
    open_task_count: taskCount.get(w.id) ?? 0,
    node_count: nodeCount.get(w.id) ?? 0,
    last_activity_at: lastActivity.get(w.id) ?? w.created_at,
  }));
}

/**
 * The organization is required and the slug is not accepted: a workspace is
 * created inside a company by someone who administers it, and its address is
 * derived from its name (see `@/lib/slugs`).
 */
const CreateSchema = z.object({
  organization: z.string().trim().min(1).max(80),
  name: z.string().min(1).max(80),
  description: z.string().max(280).optional(),
});

export const POST = withRoute(async (req: Request) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = CreateSchema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const userId = gated.kind === "user" ? gated.userId : null;
    const ws = await createWorkspaceForUser(userId, parsed.data);
    recordActivity(ws.id, "workspace", null, ws.name, "created");
    return Response.json({ workspace: ws }, { status: 201 });
  } catch (err) {
    if (err instanceof WorkspaceCreateError) {
      return Response.json(
        { error: err.code, message: err.message },
        { status: err.status },
      );
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "create failed" },
      { status: 409 },
    );
  }
});
