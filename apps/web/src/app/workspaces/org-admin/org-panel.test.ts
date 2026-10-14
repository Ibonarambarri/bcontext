import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The organization panel, as a set of rules rather than a rendering.
 *
 * These are the decisions that are easy to undo by accident six months from
 * now — a section reintroducing the slug because it was handy, a second
 * roster of agents appearing beside the people, a drawer coming back. Each one
 * cost a conversation; a grep is cheap insurance that the conversation is not
 * had twice.
 */

const here = join(process.cwd(), "src/app/workspaces");
const read = (path: string) => readFileSync(join(here, path), "utf8");

const SECTIONS = [
  "org-admin/overview-section.tsx",
  "org-admin/general-section.tsx",
  "org-admin/ai-keys-section.tsx",
  "org-admin/users-section.tsx",
  "org-admin/user-detail.tsx",
  "org-admin/invitations-section.tsx",
  "org-admin/workspaces-section.tsx",
];

describe("the organization panel", () => {
  it("is a centred dialog, blurred behind, like the profile", () => {
    const modal = read("org-admin/org-admin-modal.tsx");
    expect(modal).toContain("Modal.Backdrop");
    expect(modal).toContain("backdrop-blur-");
    expect(modal).toContain('placement="center"');
    // The right-hand Sheet it replaces, and the drawer the hub used for a
    // workspace, are both gone: administering something is a piece of work,
    // not a side panel on the page behind it.
    expect(modal).not.toContain("Sheet");
    expect(read("workspace-settings-modal.tsx")).toContain("Modal.Backdrop");
  });

  it("groups its sections instead of listing six siblings", () => {
    const modal = read("org-admin/org-admin-modal.tsx");
    for (const group of ["Organization", "People", "Projects"]) {
      expect(modal).toContain(`label: "${group}"`);
    }
  });

  it("navigates with the product's own Sidebar, not a list of buttons", () => {
    // Third place you move around inside Bcontext; it works like the other
    // two (the workspace shell and the admin panel) because it is the same
    // component, down to the group labels and the current-item treatment.
    const modal = read("org-admin/org-admin-modal.tsx");
    expect(modal).toContain('Sidebar as SidebarPrimitive');
    expect(modal).toContain("SidebarPrimitive.GroupLabel");
    expect(modal).toContain("SidebarPrimitive.MenuItem");
    // It is built for a page. The dialog undoes those page-sized rules in
    // one scoped place rather than reimplementing the component.
    expect(modal).toContain("org-panel");
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toContain(".org-panel .sidebar");
    expect(css).not.toMatch(/\.org-panel[^{]*\{[^}]*!important/);
    // The dialog's own 24px of padding left the rail floating as a grey
    // rectangle inside the window instead of being its left edge.
    expect(css).toMatch(/\.org-panel\.modal__dialog\s*\{[^}]*padding:\s*0/);
  });

  it("never prints an address, an id or a URL", () => {
    // The old General tab had a field labelled "Address" holding `/w/<slug>`,
    // and the workspace drawer printed the same line under the name. Neither
    // is something anyone copies from here, and both crowded out the facts
    // that are.
    for (const file of [...SECTIONS, "org-admin/org-admin-modal.tsx", "workspace-settings-modal.tsx"]) {
      const source = read(file);
      expect(source, file).not.toMatch(/`\/w\/\$\{/);
      expect(source, file).not.toContain("workspaceName(");
      expect(source, file).not.toMatch(/>\s*\/w\//);
    }
  });

  it("puts agents under the person answerable for them", () => {
    const users = read("org-admin/users-section.tsx");
    // One section, two lenses — not a People tab and an Agents tab, which is
    // the product's internal model showing through rather than a question
    // anybody has.
    expect(users).toContain("connected_by_user_id");
    expect(users).toContain('id="agents"');
    expect(users).toContain('id="people"');
    expect(read("org-admin/user-detail.tsx")).toContain("detail.agents");
  });

  it("gathers one person's role, reach, usage and agents on one screen", () => {
    const detail = read("org-admin/user-detail.tsx");
    expect(detail).toContain("detail.meters");
    expect(detail).not.toContain("/limits");
    expect(detail).toContain("workspaces:");
    expect(detail).toContain("role:");
  });
});
