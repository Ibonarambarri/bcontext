/**
 * `/workspaces` — the hub: every workspace the signed-in person belongs to,
 * grouped by organization. The first page after login and where `/` lands.
 *
 * Server Component. Session from Supabase Auth (`@/web/session`), everything
 * else from `GET /api/workspaces?stats=1` through `@/web/api-client`; the view
 * models built here are what `workspaces-view.tsx` renders on the client. Not
 * under `/w/…`, so the workspace shell and its providers are absent — the hub
 * carries its own top bar and toasts.
 */
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { parseWorkspaceRef } from "@bcontext-dev/contract/workspace-ref";
import type { Route } from "next";
import { apiJson } from "@/web/api-client";
import { whoami } from "@/web/me";
import { getSession } from "@/web/session";
import { showOrgLayer } from "@/lib/org-layer";
import type {
  WorkspaceCard,
  WorkspacesResponse,
} from "@bcontext-dev/contract/workspaces";
import { listTemplates } from "@bcontext-dev/contract/templates/workspaces";
import {
  WorkspacesView,
  type OrganizationVM,
  type WorkspaceVM,
} from "./workspaces-view";

export const metadata = {
  title: "Workspaces — Bcontext",
};

interface Props {
  searchParams: Promise<{ ws?: string }>;
}

/* Deterministic per slug: the same workspace gets the same hue and glyph
   on every render, with no stored preference needed. */
function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function hueFor(slug: string): number {
  const hues = [145, 250, 80, 30, 320, 60, 200, 0];
  return hues[hash(slug) % hues.length] ?? 145;
}
function glyphFor(name: string): string {
  return (name?.[0] ?? "·").toUpperCase();
}

function toVM(w: WorkspaceCard): WorkspaceVM {
  const meta = w.metadata ?? {};
  const customHue = typeof meta.accent_hue === "number" ? meta.accent_hue : null;
  return {
    id: w.id,
    slug: w.slug,
    name: w.name,
    glyph: glyphFor(w.name),
    description: w.description ?? null,
    role: w.role,
    org: {
      id: w.organization.id,
      slug: w.organization.slug,
      name: w.organization.name,
      // The caller's role in the company, which is the only role that
      // administers anything: there is no workspace-level administrator.
      role: w.organization.role,
    },
    memberCount: w.member_count,
    taskCount: w.open_task_count,
    nodeCount: w.node_count,
    accent: customHue ?? hueFor(w.slug),
    accentCustom: customHue !== null,
    metadata: meta,
    createdAt: w.created_at,
    lastActivity: w.last_activity_at,
    githubRepo: w.github_repo ?? null,
  };
}

export default async function WorkspacesIndexPage({ searchParams }: Props) {
  const sp = await searchParams;

  // Supabase off: the API answers from the demo store and there is no one to
  // sign in as, so the hub renders for a stand-in person.
  const demoMode = !isSupabaseConfigured();
  let currentUser = { id: "demo", email: "you@demo.local" as string | null };
  if (!demoMode) {
    const { data: auth } = await (await getSession()).auth.getUser();
    if (!auth.user) redirect("/login?next=/workspaces");
    currentUser = { id: auth.user.id, email: auth.user.email ?? null };
  }

  const { workspaces: cards, organizations: orgCards } =
    await apiJson<WorkspacesResponse>("/api/workspaces?stats=1");

  // Somebody with an account and no organization: if they may create one,
  // `/start` asks for its name (this is also where the confirmation email
  // lands them); otherwise the hub's empty state says who can invite them.
  // Only asked when there is nothing to show, so the common path costs no
  // extra request.
  if (!demoMode && orgCards.length === 0 && cards.length === 0) {
    const me = await whoami();
    if (me?.can_create_organization) redirect("/start" as Route);
  }

  const workspaces = cards.map(toVM);
  // What the create dialog offers as a starting point. Summarised here so the
  // template bodies (nodes, tags) never travel to the browser.
  const templates = listTemplates().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    node_count: t.nodes.length,
  }));
  // One decision, taken here and handed down: does this hub name the
  // organization at all? See `@/lib/org-layer`.
  const orgLayer = showOrgLayer({ organizations: orgCards, workspaces: cards });
  const organizations: OrganizationVM[] = orgCards.map((o) => ({
    id: o.id,
    slug: o.slug,
    name: o.name,
    role: o.role,
    workspaceCount: o.workspace_count,
    memberCount: o.member_count,
    canCreateWorkspace: o.can_create_workspace,
    canManage: o.can_manage,
  }));

  // The settings drawer is URL-driven: the roster is fetched only for the
  // workspace named in ?ws=, and only when it is one the person belongs to.
  // The parameter carries the full `<org>~<workspace>` ref; a bare slug still
  // resolves, because invitations hand one over when the org has a single
  // workspace to land in.
  const settingsWs = sp.ws ? findWorkspace(workspaces, sp.ws) : null;

  if (!settingsWs) {
    return (
      <WorkspacesView
        currentUser={currentUser}
        workspaces={workspaces}
        organizations={organizations}
        orgLayer={orgLayer}
        demoMode={demoMode}
        settingsWs={null}
        isAdmin={false}
        templates={templates}
      />
    );
  }

  return (
    <WorkspacesView
      currentUser={currentUser}
      workspaces={workspaces}
      organizations={organizations}
      orgLayer={orgLayer}
      demoMode={demoMode}
      settingsWs={settingsWs}
      // Administering is an organization role. A workspace has members, not
      // administrators of its own.
      isAdmin={
        demoMode ||
        settingsWs.org.role === "owner" ||
        settingsWs.org.role === "admin"
      }
      templates={templates}
    />
  );
}

/** `?ws=` as either `<org>~<workspace>` or the bare slug an invite sends. */
function findWorkspace(workspaces: WorkspaceVM[], raw: string): WorkspaceVM | null {
  const ref = parseWorkspaceRef(raw);
  if (ref) {
    return (
      workspaces.find((w) => w.org.slug === ref.org && w.slug === ref.workspace) ?? null
    );
  }
  return workspaces.find((w) => w.slug === raw) ?? null;
}
