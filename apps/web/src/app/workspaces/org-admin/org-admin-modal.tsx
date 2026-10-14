"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2,
  FolderTree,
  Gauge,
  KeyRound,
  Mail,
  Settings2,
  Users,
  X,
} from "lucide-react";
import { Modal, Skeleton } from "@heroui/react";
import { Sidebar as SidebarPrimitive } from "@/components/ui/sidebar";
import type {
  OrgAdminDetail,
  OrgAgentList,
  OrgUsage,
} from "@bcontext-dev/contract/organizations";
import type { SectionId } from "./panel-ui";
import { OverviewSection } from "./overview-section";
import { GeneralSection } from "./general-section";
import { UsersSection } from "./users-section";
import { InvitationsSection } from "./invitations-section";
import { WorkspacesSection } from "./workspaces-section";
import { AiKeysSection } from "./ai-keys-section";

/**
 * Administering an organization.
 *
 * A centred dialog rather than a drawer, and the same one the profile uses: an
 * administrator is not glancing at a sidebar of the page behind them, they are
 * doing a piece of work with the roster and the workspaces at once, and
 * a panel sliding off one edge of the hub made that work feel like a detour
 * from browsing. A route would be the other extreme — it loses the place they
 * came from, and they come back to it.
 *
 * The rail is the product's own `Sidebar`, the one the workspace and the
 * platform panel already navigate with, so the third place you move around
 * inside Bcontext works like the other two: the same group labels, the same
 * current-item treatment, the same keyboard tree. It is built for a page
 * (`height: 100svh`, a provider at least as tall), which is why `.org-panel`
 * in `globals.css` undoes exactly those three page-sized rules and nothing
 * else — the alternative was a hand-rolled list of buttons that looked like
 * the sidebar until the day one of them changed.
 *
 * Grouped, because the sections are not siblings: three are about the company
 * as an entity, two about the people in it, one about its projects. A flat
 * list of six made "Users" and "General" look like the same kind of thing.
 *
 * Everything is read when it opens and re-read after every write, so no two
 * sections can disagree about who is in the organization — a roster and an
 * access matrix that have drifted apart are worse than a spinner.
 */

const GROUPS = [
  {
    label: "Organization",
    items: [
      { id: "overview", label: "Overview", icon: Gauge },
      { id: "general", label: "General", icon: Settings2 },
      { id: "ai-keys", label: "AI keys", icon: KeyRound },
    ],
  },
  {
    label: "People",
    items: [
      { id: "users", label: "Users", icon: Users },
      { id: "invitations", label: "Invitations", icon: Mail },
    ],
  },
  {
    label: "Projects",
    items: [{ id: "workspaces", label: "Workspaces", icon: FolderTree }],
  },
] as const;

export function OrgAdminModal({
  orgSlug,
  onClose,
  onCreateWorkspace,
}: {
  orgSlug: string;
  onClose: () => void;
  /**
   * The Workspaces section's "New workspace". The panel does not create
   * workspaces itself; the hub's dialog does, and the hub decides what to do
   * with this panel meanwhile.
   */
  onCreateWorkspace: () => void;
}) {
  const [section, setSection] = useState<SectionId>("overview");
  const [detail, setDetail] = useState<OrgAdminDetail | null>(null);
  const [usage, setUsage] = useState<OrgUsage | null>(null);
  const [agents, setAgents] = useState<OrgAgentList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/organizations/${encodeURIComponent(orgSlug)}`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [detailRes, usageRes, agentsRes] = await Promise.all([
        fetch(base, { cache: "no-store" }),
        fetch(`${base}/usage`, { cache: "no-store" }),
        fetch(`${base}/agents`, { cache: "no-store" }),
      ]);
      if (!detailRes.ok) {
        const body = (await detailRes.json().catch(() => null)) as
          | { message?: string }
          | null;
        setError(body?.message ?? "Couldn't load this organization.");
        return;
      }
      setDetail((await detailRes.json()) as OrgAdminDetail);
      // Usage and the agent roster are extras: a company whose counters are
      // not deployed yet still has a roster to administer, and a section that
      // cannot load says so where it lives rather than blanking the panel.
      setUsage(usageRes.ok ? ((await usageRes.json()) as OrgUsage) : null);
      setAgents(agentsRes.ok ? ((await agentsRes.json()) as OrgAgentList) : null);
    } catch {
      setError("Couldn't reach the server.");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const pendingInvites = detail?.invites.length ?? 0;
  const counts = useMemo<Partial<Record<SectionId, number>>>(
    () => ({
      users: detail?.members.length,
      invitations: pendingInvites || undefined,
      workspaces: detail?.workspaces.length,
    }),
    [detail, pendingInvites],
  );

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className="backdrop-blur-[6px]"
      style={{ background: "var(--ov-backdrop, rgba(0,0,0,0.55))" }}
    >
      <Modal.Container placement="center" className="p-4">
        <Modal.Dialog
          aria-label="Manage organization"
          className="org-panel relative flex h-[86dvh] max-h-[760px] w-full max-w-[1060px] overflow-hidden border border-[var(--line)] bg-[var(--paper)] shadow-[0_30px_90px_-30px_rgba(0,0,0,0.55)]"
        >
          <Modal.CloseTrigger
            aria-label="Close (Esc)"
            className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-3)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
          >
            <X size={14} />
          </Modal.CloseTrigger>

          {/* No collapsing and no `mod+b`: inside a dialog a rail that can be
              folded away is a control with nowhere to go, and the shortcut
              belongs to the workspace sidebar behind this one. */}
          {/* `.modal__dialog` is a column flex container, so this — its only
              child — has to be told to grow. Without it the provider is as
              tall as whatever is inside, and while the panel is still loading
              that is a short skeleton: the rail stopped halfway down the
              window and the dialog's own background showed underneath it. */}
          <SidebarPrimitive.Provider
            collapsible="none"
            toggleShortcut={false}
            className="min-h-0 w-full flex-1 flex-col md:flex-row"
            style={{ "--sidebar-width": "232px" } as React.CSSProperties}
          >
            <SidebarPrimitive className="max-h-[34%] shrink-0 border-b md:max-h-none md:border-b-0 md:border-r">
              <SidebarPrimitive.Header className="px-3 pt-3">
                <div className="flex min-w-0 items-center gap-2.5 pr-8">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--paper-3)]">
                    <Building2 size={15} className="text-[var(--ink-2)]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    {detail ? (
                      <div className="truncate text-[13px] font-semibold leading-tight text-foreground">
                        {detail.name}
                      </div>
                    ) : (
                      // Not the slug: it is an address, this panel shows none,
                      // and standing it in for a company's name for half a
                      // second is how a lowercase `bcontext` ends up on screen.
                      <Skeleton className="h-[13px] w-24 rounded" />
                    )}
                    <div className="mt-0.5 text-[11.5px] leading-tight text-muted">
                      Organization
                    </div>
                  </div>
                </div>
              </SidebarPrimitive.Header>

              <SidebarPrimitive.Content>
                <nav
                  aria-label="Organization sections"
                  className="scroll flex-1 overflow-y-auto px-1 pb-3"
                >
                  {GROUPS.map((group) => (
                    <SidebarPrimitive.Group key={group.label} className="mt-3">
                      <SidebarPrimitive.GroupLabel>
                        {group.label}
                      </SidebarPrimitive.GroupLabel>
                      <SidebarPrimitive.Menu aria-label={group.label}>
                        {group.items.map((item) => (
                          <SidebarPrimitive.MenuItem
                            key={item.id}
                            id={item.id}
                            isCurrent={section === item.id}
                            onAction={() => setSection(item.id)}
                          >
                            <SidebarPrimitive.MenuIcon>
                              <item.icon size={13} />
                            </SidebarPrimitive.MenuIcon>
                            <SidebarPrimitive.MenuItemContent>
                              <SidebarPrimitive.MenuLabel>
                                {item.label}
                              </SidebarPrimitive.MenuLabel>
                              {counts[item.id] != null ? (
                                <SidebarPrimitive.MenuChip>
                                  {counts[item.id]}
                                </SidebarPrimitive.MenuChip>
                              ) : null}
                            </SidebarPrimitive.MenuItemContent>
                          </SidebarPrimitive.MenuItem>
                        ))}
                      </SidebarPrimitive.Menu>
                    </SidebarPrimitive.Group>
                  ))}
                </nav>
              </SidebarPrimitive.Content>
            </SidebarPrimitive>

            <div className="scroll min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-6 pr-12 md:px-8 md:py-7 md:pr-12">
              {error ? (
                <p role="alert" className="text-[13px] text-danger">
                  {error}
                </p>
              ) : !detail ? (
                <SectionSkeleton />
              ) : section === "overview" ? (
                <OverviewSection
                  detail={detail}
                  agents={agents}
                  onGo={setSection}
                />
              ) : section === "general" ? (
                <GeneralSection detail={detail} onChanged={load} />
              ) : section === "ai-keys" ? (
                <AiKeysSection orgSlug={detail.slug} />
              ) : section === "users" ? (
                <UsersSection
                  detail={detail}
                  agents={agents}
                  onChanged={load}
                  onGo={setSection}
                />
              ) : section === "invitations" ? (
                <InvitationsSection detail={detail} onChanged={load} />
              ) : (
                <WorkspacesSection
                  detail={detail}
                  usage={usage}
                  onCreate={onCreateWorkspace}
                />
              )}
            </div>
          </SidebarPrimitive.Provider>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/**
 * What a section looks like before it has anything to say.
 *
 * Shaped like the sections themselves — a heading, its sentence, and a few
 * blocks — rather than the generic roster of avatar rows that used to stand
 * here. A placeholder whose shape belongs to a different screen does not read
 * as "loading"; it reads as the wrong screen having opened.
 */
function SectionSkeleton() {
  return (
    <div role="status" aria-label="Loading the organization">
      <Skeleton className="h-5 w-40 rounded" />
      <Skeleton className="mt-2 h-3 w-full max-w-md rounded" />
      <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[74px] rounded-[10px]" />
        ))}
      </div>
      <Skeleton className="mt-8 h-4 w-32 rounded" />
      <Skeleton className="mt-3 h-[92px] w-full rounded-[10px]" />
      <Skeleton className="mt-3 h-[92px] w-full rounded-[10px]" />
    </div>
  );
}
