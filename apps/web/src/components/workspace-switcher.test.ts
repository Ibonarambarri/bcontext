import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { WorkspaceCard } from "@bcontext-dev/contract/workspaces";
import { ALL_WORKSPACES_PATH, workspacesOfOrganization } from "./workspace-switcher";

function workspace(slug: string, org: { id: string; name: string }): WorkspaceCard {
  return {
    id: `${org.id}-${slug}`,
    organization_id: org.id,
    slug,
    name: slug,
    description: null,
    github_repo: null,
    metadata: {},
    created_at: "2026-07-18T00:00:00.000Z",
    role: "owner",
    organization: { id: org.id, slug: org.id, name: org.name, role: "owner" },
    member_count: 1,
    open_task_count: 0,
    node_count: 0,
    last_activity_at: "2026-07-18T00:00:00.000Z",
  };
}

describe("sidebar workspace selector", () => {
  it("exposes the canonical route back to the workspace hub", () => {
    expect(ALL_WORKSPACES_PATH).toBe("/workspaces");
  });

  it("renders a headerless shell with the selector owned by the sidebar", () => {
    const shellSource = readFileSync(new URL("./workspace-shell.tsx", import.meta.url), "utf8");
    const sidebarSource = readFileSync(new URL("./sidebar.tsx", import.meta.url), "utf8");

    expect(shellSource).not.toContain("TopBar");
    expect(sidebarSource.indexOf("<WorkspaceSwitcher />")).toBeLessThan(
      sidebarSource.indexOf('<nav aria-label="Primary workspace navigation"'),
    );
    // Collapsed sidebar hides entirely (offcanvas) — the shell's native
    // Trigger reopens it, so no compact selector variant exists anymore.
    expect(shellSource).toContain("SidebarShell.Trigger");
    expect(sidebarSource).toContain("SidebarPrimitive.Mobile");
  });
});

describe("one organization at a time", () => {
  const acme = { id: "acme", name: "Acme" };
  const bolt = { id: "bolt", name: "Bolt" };

  it("lists only the workspaces of the organization you are in, by name", () => {
    const list = workspacesOfOrganization(
      [
        workspace("product", acme),
        workspace("docs", bolt),
        workspace("archive", acme),
      ],
      "acme",
    );

    expect(list.map((w) => w.slug)).toEqual(["archive", "product"]);
  });

  it("falls back to everything when the workspace has no organization yet", () => {
    const list = workspacesOfOrganization(
      [workspace("docs", bolt), workspace("product", acme)],
      null,
    );

    expect(list.map((w) => w.slug)).toEqual(["docs", "product"]);
  });
});
