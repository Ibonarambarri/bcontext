"use client";

/**
 * The workspace switcher at the top of the sidebar: the current workspace
 * as a gradient tile + name (+ organization when the org layer is shown)
 * and a dropdown of its sibling workspaces, with one link out to
 * `/workspaces`. Data comes from the workspace context — the hub's card
 * list is passed down by the layout, so switching needs no fetch.
 *
 * `workspacesOfOrganization` is pure and unit-tested (`workspace-switcher.test.ts`).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Building2, ChevronsUpDown } from "lucide-react";
import { Dropdown, Header, Separator } from "@heroui/react";
import type { WorkspaceCard } from "@bcontext-dev/contract/workspaces";
import { parseWorkspaceRef } from "@bcontext-dev/contract/workspace-ref";
import { gradientCss, gradientFor } from "@bcontext-dev/contract/workspace-gradients";
import { workspacePath, workspaceName } from "@/web/workspace-url";
import { useWorkspace } from "./workspace-context";

export const ALL_WORKSPACES_PATH = "/workspaces" as Route;

/**
 * The workspaces of one organization, by name — the menu shows one
 * organization only, because a slug only says which workspace it means
 * inside one: two companies both get to have a `docs`.
 *
 * The organization is taken from the workspace currently open, so the menu is
 * about where you already are. A person who belongs to three companies sees
 * the projects of the one they are working in — the other two are a click
 * away under "All organizations", and putting them in this list would make
 * the common move (switch project) share a menu with the rare one (switch
 * company).
 */
export function workspacesOfOrganization(
  workspaces: WorkspaceCard[],
  organizationId: string | null,
): WorkspaceCard[] {
  if (!organizationId) return [...workspaces].sort((a, b) => a.name.localeCompare(b.name));
  return workspaces
    .filter((w) => w.organization.id === organizationId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function WorkspaceSwitcher() {
  const {
    address,
    workspace,
    workspaces,
    workspaceSlug,
    orgLayer,
  } = useWorkspace();
  const router = useRouter();

  const initial = (workspace?.name ?? workspaceSlug).slice(0, 1).toUpperCase();
  const activeGradient = gradientFor({
    slug: workspaceSlug,
    metadata: workspace?.metadata ?? null,
  });
  const organization = workspace?.organization ?? null;
  const siblings = workspacesOfOrganization(workspaces, organization?.id ?? null);

  // Keys are `<org>/<workspace>`, the one spelling that is unique across
  // every organization the person belongs to.
  const keyOf = (item: WorkspaceCard) =>
    workspaceName({ org: item.organization.slug, slug: item.slug });

  const navigateToWorkspace = (key: string) => {
    const ref = parseWorkspaceRef(key);
    if (!ref) return;
    router.push(workspacePath({ org: ref.org, slug: ref.workspace }) as Route);
  };

  const renderRow = (item: WorkspaceCard) => {
    const gradient = gradientFor({ slug: item.slug, metadata: item.metadata ?? null });
    return (
      <Dropdown.Item
        key={item.id}
        id={keyOf(item)}
        textValue={item.name}
        className="rounded-lg px-2.5 py-2 text-[13px] text-[var(--ink-2)] data-[hovered=true]:bg-[var(--paper-2)] data-[hovered=true]:text-[var(--ink)] data-[selected=true]:bg-[var(--paper-3)] data-[selected=true]:text-[var(--ink)]"
      >
        {({ isSelected }: { isSelected: boolean }) => (
          <div className="flex w-full items-center gap-2">
            <WorkspaceAvatar
              initial={item.name.slice(0, 1).toUpperCase()}
              gradient={gradient}
              size={20}
              textSize={12}
            />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            {isSelected ? <Dropdown.ItemIndicator className="text-[var(--ink-3)]" /> : null}
          </div>
        )}
      </Dropdown.Item>
    );
  };

  return (
    <div className="relative min-w-0 flex-1">
      <Dropdown>
        <Dropdown.Trigger
          aria-label="Switch workspace"
          className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[var(--paper-2)] outline-none ring-0 data-[focus-visible]:ring-0 data-[focus-visible]:outline-none"
        >
          <span
            title="Switch workspace"
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <WorkspaceAvatar
              initial={initial}
              gradient={activeGradient}
              size={32}
              textSize={18}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium leading-tight text-foreground">
                {workspace?.name ?? workspaceSlug}
              </span>
              {/* The company, not the URL. An address under the name is
                  something to copy, and nobody copies it from here. */}
              <span className="truncate text-[11px] leading-tight text-muted">
                {orgLayer && organization ? organization.name : address.slug}
              </span>
            </span>
            <ChevronsUpDown size={13} className="shrink-0 text-muted" />
          </span>
        </Dropdown.Trigger>

        <Dropdown.Popover
          placement="bottom start"
          className="w-[var(--trigger-width)] min-w-[248px] rounded-xl p-1.5 fade-in outline-none ring-0 data-[focus-visible]:ring-0 data-[focus-visible]:outline-none"
        >
          <Dropdown.Menu
            aria-label="Workspace selector"
            selectionMode="single"
            selectedKeys={new Set([workspaceName(address)])}
            onAction={(key) => navigateToWorkspace(String(key))}
          >
            <Dropdown.Section>
              {/* The company is named once, at the top, and then never
                  repeated on the rows: every workspace below belongs to it. */}
              {orgLayer && organization ? (
                <Header className="mono px-2 pb-1 pt-1.5 text-[9.5px] uppercase tracking-widest text-[var(--ink-mute)]">
                  {organization.name}
                </Header>
              ) : null}
              {siblings.map((item) => renderRow(item))}
            </Dropdown.Section>
          </Dropdown.Menu>

          <Separator className="my-1 border-t border-[var(--line)]" />

          {/* The only way out of this organization. Settings for the workspace
              are not here: this menu answers "which project", and a settings
              row inside it made choosing a project and configuring one look
              like the same kind of act. Cmd+, still opens them. */}
          <Link
            href={ALL_WORKSPACES_PATH}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
          >
            {orgLayer ? "All organizations" : "All workspaces"}
            <Building2 size={14} className="ml-auto text-muted" />
          </Link>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );
}

/**
 * Gradient identity tile. Avatar proportions: the glyph runs at ~55–60% of
 * the tile edge (semibold, line-height 1 so it centres optically) — at a
 * polite ~44% the letter is illegible at sidebar sizes.
 */
function WorkspaceAvatar({
  initial,
  gradient,
  size,
  textSize,
}: {
  initial: string;
  gradient: { from: string; to: string };
  size: number;
  textSize: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: textSize,
        lineHeight: 1,
        background: gradientCss(gradient as never),
        textShadow: "0 1px 1px rgba(0,0,0,0.18)",
      }}
    >
      {initial}
    </div>
  );
}
