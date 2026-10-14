"use client";

/**
 * Workspaces hub — the launcher listing every workspace the user belongs to,
 * grouped by the organization that owns it.
 *
 * Matches the Agents surface family: clean header row, a Filter toggle that
 * reveals an Activity-style filters bar (grid-template-rows height
 * animation), a responsive card grid, and dialogs for creating a workspace,
 * a workspace's settings and the organization panel. All chrome comes from
 * HeroUI, src/components/ui and theme tokens.
 *
 * A workspace slug is unique inside its organization, so a section is the
 * only place a name like `docs` is unambiguous — which is why the grouping
 * is structural here rather than a filter people opt into.
 *
 * All of that is true once there is an organization worth naming. Below that
 * — one company, one workspace, one person — `orgLayer` is false and the hub
 * is a flat grid of workspaces: no section headers, no organization filter,
 * no `/w/<org>/<ws>` address on the cards. The predicate is `@/lib/org-layer`.
 *
 * What never hides is the two things an administrator comes here to do:
 * create a workspace and administer the organization — the layer decides how
 * the hub *talks*, not what it lets you do. Each lives in exactly one place:
 * with a single organization the page header carries the pair and the
 * section (when the layer draws one) carries nothing; with several, each
 * section carries its own pair so the dialog opens on the right company, and
 * the page header carries none. Two buttons for one action, one above the
 * other, is what this replaced.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import type { ComponentType } from "react";
import {
  ArrowDownUp,
  Building2,
  ChevronRight,
  GitBranch,
  LayoutGrid,
  Plus,
  Search,
  Settings,
  Settings2,
  SlidersHorizontal,
  UserRound,
  X,
} from "lucide-react";
import {
  Button,
  Chip,
  Input,
  Label,
  ListBox,
  Select,
  TextField,
} from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { ItemCard } from "@/components/ui/item-card";
import { WorkspaceSettingsModal } from "./workspace-settings-modal";
import { NewWorkspaceModal, type TemplateSummary } from "./new-workspace-modal";
import { OrgAdminModal } from "./org-admin/org-admin-modal";
import { UserMenu } from "@/components/user-menu";
import { cn } from "@bcontext-dev/contract/utils";
import { gradientCss, gradientFor } from "@bcontext-dev/contract/workspace-gradients";
import { workspacePath, workspaceApiRef } from "@/web/workspace-url";

type Role = "owner" | "admin" | "editor" | "viewer" | "agent";

/** The organization a workspace belongs to, as its card and section name it. */
interface WorkspaceOrgVM {
  id: string;
  slug: string;
  name: string;
  /**
   * The caller's role in the company. It is the only role that administers
   * anything: a workspace has members, not administrators of its own.
   */
  role: "owner" | "admin" | "editor" | "viewer" | null;
}

/**
 * An organization the person belongs to. It gets a section even with no
 * workspaces in it — that is what a company looks like on its first day, and
 * the empty section is where the first workspace gets created.
 */
export interface OrganizationVM {
  id: string;
  slug: string;
  name: string;
  /** The caller's role in the organization, not in any of its workspaces. */
  role: "owner" | "admin" | "editor" | "viewer";
  memberCount: number;
  canCreateWorkspace: boolean;
  /** Owner or admin of the organization: the only ones who administer it. */
  canManage: boolean;
}

/** A workspace card, as `page.tsx` builds it from the API's `WorkspaceCard`. */
export interface WorkspaceVM {
  id: string;
  slug: string;
  name: string;
  glyph: string;
  description: string | null;
  role: Role;
  org: WorkspaceOrgVM;
  memberCount: number;
  taskCount: number;
  nodeCount: number;
  accent: number;
  /** True if the accent was explicitly chosen (otherwise it's deterministic). */
  accentCustom: boolean;
  /** Workspace metadata blob — reads `accent_gradient` for the gradient theme. */
  metadata: Record<string, unknown> | null;
  createdAt: string;
  lastActivity: string;
  githubRepo: string | null;
}

interface Props {
  currentUser: { id: string; email: string | null };
  workspaces: WorkspaceVM[];
  organizations: OrganizationVM[];
  /** Is the organization level worth showing? See `@/lib/org-layer`. */
  orgLayer: boolean;
  demoMode: boolean;
  /** Workspace whose settings drawer should open (driven by `?ws=` in the URL). */
  settingsWs: WorkspaceVM | null;
  isAdmin: boolean;
  /** What a new workspace may start with; the create dialog offers them. */
  templates: TemplateSummary[];
}

const mono: React.CSSProperties = {
  fontFamily: "var(--f-martian-mono), var(--font-mono), monospace",
};

const display: React.CSSProperties = {
  fontFamily: "var(--f-bricolage), var(--font-sans), sans-serif",
  fontWeight: 700,
  letterSpacing: "-0.028em",
};

function relAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Math.max(1, (Date.now() - t) / 1000);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 14) return `${Math.floor(diff / 86400)}d ago`;
  // Fixed locale: toLocaleDateString() hydration-mismatches when the server
  // (en-US) and the browser (e.g. es) disagree on date order.
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}

/* ── Filters ─────────────────────────────────────────────────────────── */

type SortKey = "activity" | "name" | "created";

interface HubFilters {
  q: string;
  role: "" | Role;
  /** An organization slug, or "" for every one of them. */
  org: string;
  sort: SortKey;
}

const EMPTY_FILTERS: HubFilters = { q: "", role: "", org: "", sort: "activity" };

function countActiveFilters(filters: HubFilters): number {
  let count = 0;
  if (filters.q.trim() !== "") count += 1;
  if (filters.role !== "") count += 1;
  if (filters.org !== "") count += 1;
  if (filters.sort !== "activity") count += 1;
  return count;
}

/* ── Collapsed sections ──────────────────────────────────────────────── */

/**
 * One key per organization, so collapsing a company on this browser says
 * nothing about the others and an organization that appears later starts
 * expanded like every other. Storage is per-browser and best-effort: a
 * private window or blocked site data throws on read, and the hub renders
 * fully expanded, which is the state everything starts in anyway.
 */
const collapsedKey = (orgId: string) => `bcontext:workspaces:org:${orgId}:collapsed`;

function readCollapsed(orgIds: string[]): Set<string> {
  const collapsed = new Set<string>();
  for (const id of orgIds) {
    try {
      if (window.localStorage.getItem(collapsedKey(id)) === "1") collapsed.add(id);
    } catch {
      /* storage unavailable — the section stays expanded */
    }
  }
  return collapsed;
}

function writeCollapsed(orgId: string, collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(collapsedKey(orgId), "1");
    else window.localStorage.removeItem(collapsedKey(orgId));
  } catch {
    /* storage unavailable — the choice lives for this page view only */
  }
}

export function WorkspacesView({
  currentUser,
  workspaces,
  organizations,
  orgLayer,
  demoMode: _demoMode,
  settingsWs,
  isAdmin,
  templates,
}: Props) {
  const router = useRouter();
  /** The organization whose administration modal is open, by slug. */
  const [managing, setManaging] = useState<string | null>(null);
  /**
   * The create dialog: closed, or open with the organization the person was
   * looking at (null when they asked from nowhere in particular).
   */
  const [creating, setCreating] = useState<
    { org: OrganizationVM | null } | null
  >(null);
  const [filters, setFilters] = useState<HubFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const activeFilterCount = countActiveFilters(filters);

  // The settings drawer is URL-driven: ?ws=<org>~<workspace> opens it for that
  // workspace. Closing clears the param so the grid is the canonical hub state.
  const closeSettings = () => router.push("/workspaces" as Route);
  const openSettings = (ws: WorkspaceVM) =>
    router.push(
      `/workspaces?ws=${workspaceApiRef({ org: ws.org.slug, slug: ws.slug })}` as Route,
    );

  // Every organization the person belongs to, plus any that only shows up on
  // a workspace card — a section is never dropped just because the two reads
  // disagree.
  const sections = useMemo(() => {
    const byId = new Map<string, OrganizationVM>();
    for (const org of organizations) byId.set(org.id, org);
    for (const ws of workspaces) {
      if (byId.has(ws.org.id)) continue;
      byId.set(ws.org.id, {
        id: ws.org.id,
        slug: ws.org.slug,
        name: ws.org.name,
        role: "viewer",
        memberCount: 0,
        canCreateWorkspace: false,
        canManage: false,
      });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [organizations, workspaces]);

  // Collapsed sections are a per-browser preference, so they are read after
  // hydration: the server has no way to know them and rendering them from
  // storage on the first pass would mismatch the HTML it sent.
  useEffect(() => {
    setCollapsed(readCollapsed(sections.map((org) => org.id)));
  }, [sections]);

  const toggleSection = (orgId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      const collapse = !next.has(orgId);
      if (collapse) next.add(orgId);
      else next.delete(orgId);
      writeCollapsed(orgId, collapse);
      return next;
    });
  };

  const visible = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const filtered = workspaces.filter((w) => {
      if (
        q &&
        !w.name.toLowerCase().includes(q) &&
        !w.slug.toLowerCase().includes(q) &&
        !(w.description ?? "").toLowerCase().includes(q)
      ) {
        return false;
      }
      if (filters.role && w.role !== filters.role) return false;
      if (filters.org && w.org.slug !== filters.org) return false;
      return true;
    });
    return filtered.toSorted((a, b) => {
      if (filters.sort === "name") return a.name.localeCompare(b.name);
      if (filters.sort === "created") {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
    });
  }, [workspaces, filters]);

  const shownSections = filters.org
    ? sections.filter((org) => org.slug === filters.org)
    : sections;
  // One organization: the page header owns both actions. Several: each
  // section owns its own, and `soleOrg` is null so the header shows none.
  const soleOrg = sections.length === 1 ? sections[0] ?? null : null;
  const openCreate = (org: OrganizationVM | null) => setCreating({ org });
  const nothingMatches = workspaces.length > 0 && visible.length === 0;

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-[var(--paper)] text-[13px] text-[var(--ink)]" style={{ fontFamily: "var(--f-figtree), var(--font-sans), ui-sans-serif, sans-serif" }}>
      <TopNav />

      <main className="scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-7 pb-16 pt-7 max-sm:px-4 max-sm:pb-[calc(56px+env(safe-area-inset-bottom))] max-sm:pt-5">
          {sections.length === 0 ? (
            <HubEmptyState />
          ) : (
            <>
              {/* Header row — Agents family: title block · Filter toggle · CTA. */}
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <h1 className="m-0 text-[24px] leading-tight text-[var(--ink)]" style={display}>
                    Workspaces
                  </h1>
                  <p className="mt-0.5 text-[12px] text-[var(--ink-3)]">
                    {workspaces.length}{" "}
                    {workspaces.length === 1 ? "workspace" : "workspaces"}
                    {orgLayer ? (
                      <>
                        {" "}across {sections.length}{" "}
                        {sections.length === 1 ? "organization" : "organizations"}
                      </>
                    ) : null}{" "}
                    · sorted by{" "}
                    {filters.sort === "name"
                      ? "name"
                      : filters.sort === "created"
                        ? "creation date"
                        : "last activity"}
                  </p>
                </div>
                <span className="ml-auto" />
                <Button
                  size="sm"
                  variant={filtersOpen ? "secondary" : "outline"}
                  aria-expanded={filtersOpen}
                  aria-controls="workspace-filters-panel"
                  onPress={() => setFiltersOpen((open) => !open)}
                  className={cn("gap-1.5", filtersOpen && "border-[var(--line-strong)]")}
                >
                  <SlidersHorizontal
                    size={13}
                    className={cn(
                      "transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                      filtersOpen && "rotate-90",
                    )}
                  />
                  Filter
                  {activeFilterCount > 0 ? (
                    <Chip size="sm" variant="soft" color="accent" className="h-4 min-w-4 px-1 text-[10px]">
                      {activeFilterCount}
                    </Chip>
                  ) : null}
                </Button>
                {soleOrg?.canManage ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onPress={() => setManaging(soleOrg.slug)}
                  >
                    <Settings2 size={13} /> Manage organization
                  </Button>
                ) : null}
                {soleOrg?.canCreateWorkspace ? (
                  <Button
                    size="sm"
                    className="gap-1.5"
                    onPress={() => openCreate(soleOrg)}
                  >
                    <Plus size={14} /> New workspace
                  </Button>
                ) : null}
              </div>

              {/* Collapsible filters — grid-rows height animation, no jumps. */}
              <div
                id="workspace-filters-panel"
                inert={!filtersOpen}
                className={cn(
                  "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                  filtersOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  <div
                    className={cn(
                      "transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                      filtersOpen ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0",
                    )}
                  >
                    <HubFiltersBar
                      filters={filters}
                      setFilters={setFilters}
                      organizations={sections}
                      showOrgFilter={orgLayer}
                    />
                    <div className="h-1" />
                  </div>
                </div>
              </div>

              {nothingMatches ? (
                <p className="mt-8 py-6 text-center text-[12px] text-[var(--ink-3)]">
                  No workspaces match these filters.
                </p>
              ) : (
                <div className="mt-5">
                  {orgLayer ? (
                    shownSections.map((org) => (
                      <OrgSection
                        key={org.id}
                        org={org}
                        workspaces={visible.filter((w) => w.org.id === org.id)}
                        isEmpty={workspaces.every((w) => w.org.id !== org.id)}
                        collapsed={collapsed.has(org.id)}
                        onToggle={() => toggleSection(org.id)}
                        actions={soleOrg === null}
                        onManage={() => setManaging(org.slug)}
                        onCreate={() => openCreate(org)}
                        onSettings={openSettings}
                      />
                    ))
                  ) : workspaces.length === 0 ? (
                    // One company, nothing in it: the first workspace, with
                    // no mention of the company it will live in.
                    <EmptyOrg org={soleOrg} orgLayer={false} onCreate={() => openCreate(soleOrg)} />
                  ) : (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {visible.map((ws) => (
                        <WorkspaceCard
                          key={ws.id}
                          ws={ws}
                          orgLayer={false}
                          onSettings={() => openSettings(ws)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {managing ? (
        <OrgAdminModal
          orgSlug={managing}
          onClose={() => {
            setManaging(null);
            // A person may have been let in or removed: the grid is a
            // projection of that.
            router.refresh();
          }}
          onCreateWorkspace={() => {
            // The panel's own "New workspace" hands over to this dialog: one
            // place creates workspaces, and it is not inside the panel.
            const org = sections.find((o) => o.slug === managing) ?? null;
            setManaging(null);
            openCreate(org);
          }}
        />
      ) : null}
      {creating ? (
        <NewWorkspaceModal
          organizations={sections}
          initialOrganization={creating.org}
          orgLayer={orgLayer}
          templates={templates}
          onClose={() => setCreating(null)}
        />
      ) : null}
      {settingsWs ? (
        <WorkspaceSettingsModal
          ws={settingsWs}
          isAdmin={isAdmin}
          orgLayer={orgLayer}
          onClose={closeSettings}
        />
      ) : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/*  Organization section — header, its cards, and a rule before  */
/*  the next company. Collapsing is remembered per browser, so   */
/*  someone who works in one company keeps the others folded.    */
/* ──────────────────────────────────────────────────────────── */
function OrgSection({
  org,
  workspaces,
  isEmpty,
  collapsed,
  actions,
  onToggle,
  onManage,
  onCreate,
  onSettings,
}: {
  org: OrganizationVM;
  workspaces: WorkspaceVM[];
  /** The organization holds no workspaces at all — not merely none matching. */
  isEmpty: boolean;
  collapsed: boolean;
  /**
   * Draw this section's own "Manage" and "New workspace". False when the
   * page header already carries them for the one organization there is.
   */
  actions: boolean;
  onToggle: () => void;
  onManage: () => void;
  /** Open the wizard with this organization already chosen. */
  onCreate: () => void;
  onSettings: (ws: WorkspaceVM) => void;
}) {
  const panelId = `org-section-${org.id}`;
  return (
    <section className="border-t border-[var(--line)] pb-7 pt-7 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={!collapsed}
          aria-controls={panelId}
          onPress={onToggle}
          className="-ml-1.5 h-auto gap-2 px-1.5 py-1 font-normal"
        >
          <ChevronRight
            size={14}
            className={cn(
              "shrink-0 text-[var(--ink-3)] transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
              !collapsed && "rotate-90",
            )}
          />
          <Building2 size={13} className="shrink-0 text-[var(--ink-3)]" />
          <span className="text-[14px] font-semibold text-[var(--ink)]" style={{ letterSpacing: "-.01em" }}>
            {org.name}
          </span>
        </Button>
        <span className="text-[11px] text-[var(--ink-3)]" style={mono}>
          {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}
        </span>
        <Chip size="sm" variant="secondary" className="capitalize">
          {org.role}
        </Chip>
        <span className="ml-auto" />
        {actions && org.canManage ? (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onPress={onManage}
          >
            <Settings2 size={13} /> Manage organization
          </Button>
        ) : null}
        {actions && org.canCreateWorkspace && !isEmpty ? (
          <Button size="sm" variant="outline" className="gap-1.5" onPress={onCreate}>
            <Plus size={13} /> New workspace
          </Button>
        ) : null}
      </div>

      <div
        id={panelId}
        inert={collapsed}
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {isEmpty ? (
            <EmptyOrg org={org} orgLayer onCreate={onCreate} />
          ) : workspaces.length === 0 ? (
            <p className="py-5 text-[12px] text-[var(--ink-3)]">
              No workspaces here match these filters.
            </p>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {workspaces.map((ws) => (
                <WorkspaceCard
                  key={ws.id}
                  ws={ws}
                  orgLayer
                  onSettings={() => onSettings(ws)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────────────────────────────────────── */
/*  Top nav — slim wordmark bar; nav migration tracked apart.   */
/* ──────────────────────────────────────────────────────────── */
function TopNav() {
  return (
    <div className="flex h-[56px] shrink-0 items-center gap-3.5 border-b border-[var(--line)] bg-[var(--paper)] px-5 max-sm:px-3.5">
      <Link
        // `/` server-redirects straight back to this page. The wordmark on
        // the hub points at the hub.
        href={"/workspaces" as Route}
        className="inline-flex items-center text-[16px] font-semibold tracking-[-.015em] text-[var(--ink)] no-underline"
      >
        Bcontext
      </Link>
      <span className="flex-1" />
      {/* The same account row as the workspace sidebar's footer, down to the
          avatar and the two lines: one account menu, two places. */}
      <div className="w-[200px] max-sm:w-auto">
        <UserMenu align="down" profileCard />
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/*  Filters bar — same anatomy as the Agents/Activity bars.     */
/* ──────────────────────────────────────────────────────────── */
function HubFiltersBar({
  filters,
  setFilters,
  organizations,
  showOrgFilter,
}: {
  filters: HubFilters;
  setFilters: React.Dispatch<React.SetStateAction<HubFilters>>;
  organizations: OrganizationVM[];
  /** One organization and nothing to tell apart: no filter for it. */
  showOrgFilter: boolean;
}) {
  const set = <K extends keyof HubFilters>(key: K, value: HubFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const activeCount = countActiveFilters(filters);
  const hasActiveFilters = activeCount > 0;

  return (
    <section
      aria-label="Workspace filters"
      className="mt-4 rounded-[calc(var(--radius)+6px)] border border-border bg-surface/90 p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          Filter workspaces
        </h3>
        <Chip
          size="sm"
          variant={hasActiveFilters ? "soft" : "secondary"}
          color={hasActiveFilters ? "accent" : "default"}
        >
          <Chip.Label>{hasActiveFilters ? `${activeCount} active` : "No filters"}</Chip.Label>
        </Chip>
      </header>

      <div
        className={cn(
          "grid grid-cols-1 items-end gap-3.5 sm:grid-cols-2",
          showOrgFilter
            ? "md:grid-cols-[2fr_1fr_1fr_1fr_auto]"
            : "md:grid-cols-[2fr_1fr_1fr_auto]",
        )}
      >
        <FilterField label="Search" Icon={Search}>
          <TextField
            aria-label="Search workspaces"
            value={filters.q}
            onChange={(value) => set("q", value)}
            fullWidth
          >
            <Input placeholder="Name, slug or description" />
          </TextField>
        </FilterField>
        {showOrgFilter ? (
          <FilterField label="Organization" Icon={Building2}>
            <FilterSelect
              aria-label="Organization"
              value={filters.org}
              onChange={(value) => set("org", value)}
              items={[
                { id: "", label: "All organizations" },
                ...organizations.map((org) => ({ id: org.slug, label: org.name })),
              ]}
            />
          </FilterField>
        ) : null}
        <FilterField label="Your role" Icon={UserRound}>
          <FilterSelect
            aria-label="Your role"
            value={filters.role}
            onChange={(value) => set("role", value as HubFilters["role"])}
            items={[
              { id: "", label: "All roles" },
              { id: "owner", label: "Owner" },
              { id: "admin", label: "Admin" },
              { id: "editor", label: "Editor" },
              { id: "viewer", label: "Viewer" },
            ]}
          />
        </FilterField>
        <FilterField label="Sort by" Icon={ArrowDownUp}>
          <FilterSelect
            aria-label="Sort by"
            value={filters.sort}
            onChange={(value) => set("sort", (value || "activity") as SortKey)}
            items={[
              { id: "activity", label: "Last activity" },
              { id: "name", label: "Name" },
              { id: "created", label: "Newest" },
            ]}
          />
        </FilterField>
        <Button
          variant="ghost"
          size="sm"
          isDisabled={!hasActiveFilters}
          onPress={() => setFilters(EMPTY_FILTERS)}
          className="mb-0.5 justify-self-end"
        >
          <X size={14} /> Clear
        </Button>
      </div>
    </section>
  );
}

function FilterField({
  label,
  Icon,
  children,
}: {
  label: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <Label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        <Icon size={13} className="opacity-80" />
        {label}
      </Label>
      {children}
    </div>
  );
}

function FilterSelect({
  "aria-label": ariaLabel,
  value,
  onChange,
  items,
}: {
  "aria-label": string;
  value: string;
  onChange: (value: string) => void;
  items: Array<{ id: string; label: string }>;
}) {
  return (
    <Select aria-label={ariaLabel} value={value} onChange={(key) => onChange(key == null ? "" : String(key))}>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((item) => (
            <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
              {item.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/* ──────────────────────────────────────────────────────────── */
/*  Workspace card — AgentCard family: identity row, one-line    */
/*  description, mono counts, dashed-free footer with chips and  */
/*  last-activity timestamp. Gradient glyph stays custom (it is  */
/*  product domain, per workspace-gradients.ts). The settings    */
/*  gear is a sibling of the card link — no click-hijacking.     */
/* ──────────────────────────────────────────────────────────── */
function WorkspaceCard({
  ws,
  orgLayer,
  onSettings,
}: {
  ws: WorkspaceVM;
  /** Spell the full `/w/<org>/<ws>` address, or just the workspace. */
  orgLayer: boolean;
  onSettings: () => void;
}) {
  const grad = gradientFor({ slug: ws.slug, metadata: ws.metadata });

  return (
    <div className="group relative">
      <ItemCard<"a">
        variant="outline"
        className="h-full min-h-[168px] flex-col items-stretch gap-3 rounded-[12px] border-[var(--line)] bg-[var(--paper)] p-4 text-left no-underline transition-colors hover:border-[var(--ink-mute)] hover:bg-[var(--paper-2)]"
        render={(props) => (
          <Link {...props} href={workspacePath({ org: ws.org.slug, slug: ws.slug }) as Route} />
        )}
      >
        <div className="flex items-start gap-3">
          <ItemCard.Icon
            className="size-10 shrink-0 rounded-[10px] text-[17px] font-bold text-white"
            style={{ background: gradientCss(grad), textShadow: "0 1px 1px rgba(0,0,0,.2)" }}
          >
            {ws.glyph}
          </ItemCard.Icon>
          <ItemCard.Content className="min-w-0 flex-1">
            <ItemCard.Title className="truncate text-[14px] font-medium text-[var(--ink)]">
              {ws.name}
            </ItemCard.Title>
            <ItemCard.Description className="mt-0.5 truncate text-[10.5px] text-[var(--ink-3)]" style={mono}>
              {orgLayer ? `/w/${ws.org.slug}/${ws.slug}` : ws.slug}
            </ItemCard.Description>
          </ItemCard.Content>
          <Chip size="sm" variant="soft" className="mr-8 shrink-0 capitalize">
            {ws.role}
          </Chip>
        </div>

        <p className="m-0 line-clamp-1 text-[12px] leading-[1.5] text-[var(--ink-2)]">
          {ws.description || "No description yet."}
        </p>

        <div className="flex items-center gap-3.5 text-[10.5px] text-[var(--ink-3)]" style={mono}>
          <span>
            <b className="font-medium text-[var(--ink)]">{ws.nodeCount}</b>{" "}
            {ws.nodeCount === 1 ? "node" : "nodes"}
          </span>
          <span>
            <b className="font-medium text-[var(--ink)]">{ws.taskCount}</b> open
          </span>
          <span>
            <b className="font-medium text-[var(--ink)]">{ws.memberCount}</b>{" "}
            {ws.memberCount === 1 ? "member" : "members"}
          </span>
        </div>

        <div className="mt-auto flex items-center gap-1.5 border-t border-[var(--line)] pt-3">
          {ws.githubRepo ? (
            <Chip size="sm" variant="secondary" className="text-[10px]">
              <GitBranch size={10} />
              <Chip.Label>repo</Chip.Label>
            </Chip>
          ) : null}
          {/* `relAgo` reads the clock while it renders, so the server says
              "59s ago" and the browser, hydrating a moment later, says "1m
              ago". That mismatch is React error #418, which we were actually
              collecting from this page. The value is meant to differ; this
              is the one place the difference is intended rather than a bug. */}
          <span
            suppressHydrationWarning
            className="ml-auto whitespace-nowrap font-mono text-[10px] text-[var(--ink-3)]"
          >
            active {relAgo(ws.lastActivity)}
          </span>
        </div>
      </ItemCard>

      <Button
        isIconOnly
        size="sm"
        variant="tertiary"
        aria-label={`Settings for ${ws.name}`}
        onPress={onSettings}
        className="absolute right-2.5 top-2.5 z-[2] opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Settings size={14} />
      </Button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/*  Empty states                                                 */
/* ──────────────────────────────────────────────────────────── */

/**
 * Nothing to show at all: the person belongs to no organization. Anybody who
 * may create one is sent to `/start` before this renders (`page.tsx`), so the
 * people who see it are on an instance where organizations are created by
 * its administrators — the honest thing is to say who can let them in, not
 * to offer a button that would fail.
 */
function HubEmptyState() {
  return (
    <EmptyState className="mt-10 min-h-[340px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)]">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <LayoutGrid size={18} />
        </EmptyState.Media>
        <EmptyState.Title>You&apos;re not in an organization yet</EmptyState.Title>
        <EmptyState.Description className="max-w-[430px]">
          On this instance, organizations are created by its administrators.
          Ask one of them, or an owner of your organization, for an invitation.
        </EmptyState.Description>
      </EmptyState.Header>
    </EmptyState>
  );
}

/**
 * An organization with nothing in it yet — day one of a company. The button
 * opens the same create dialog as the header's.
 */
function EmptyOrg({
  org,
  orgLayer,
  onCreate,
}: {
  org: OrganizationVM | null;
  orgLayer: boolean;
  onCreate: () => void;
}) {
  const canCreate = org?.canCreateWorkspace ?? false;
  return (
    <EmptyState className="mt-3 min-h-[180px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)]">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <LayoutGrid size={18} />
        </EmptyState.Media>
        <EmptyState.Title>
          {orgLayer && org ? `Nothing in ${org.name} yet` : "No workspaces yet"}
        </EmptyState.Title>
        <EmptyState.Description className="max-w-[430px]">
          {canCreate
            ? "One workspace per product, team or client, with its own members and agents."
            : orgLayer
              ? "An owner or admin of this organization creates the first workspace."
              : "An admin creates the first workspace."}
        </EmptyState.Description>
      </EmptyState.Header>
      {canCreate ? (
        <EmptyState.Content>
          <Button size="sm" className="gap-1.5" onPress={onCreate}>
            <Plus size={14} /> New workspace
          </Button>
        </EmptyState.Content>
      ) : null}
    </EmptyState>
  );
}
