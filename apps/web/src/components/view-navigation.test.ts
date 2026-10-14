import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("workspace sidebar", () => {
  it("keeps Dashboard, Nexos and Conflicts on top, then the Knowledge and Agents & Tools groups", () => {
    const sidebar = read("./sidebar.tsx");
    const dashboard = sidebar.indexOf("<SidebarPrimitive.MenuLabel>Dashboard</SidebarPrimitive.MenuLabel>");
    const nexos = sidebar.indexOf("<SidebarPrimitive.MenuLabel>Nexos</SidebarPrimitive.MenuLabel>");
    const conflicts = sidebar.indexOf("<SidebarPrimitive.MenuLabel>Conflicts</SidebarPrimitive.MenuLabel>");
    const knowledge = sidebar.indexOf("<SidebarPrimitive.GroupLabel>Knowledge</SidebarPrimitive.GroupLabel>");
    const agents = sidebar.indexOf("<SidebarPrimitive.GroupLabel>Agents & Tools</SidebarPrimitive.GroupLabel>");
    expect(dashboard).toBeGreaterThan(-1);
    expect(dashboard).toBeLessThan(nexos);
    expect(nexos).toBeLessThan(conflicts);
    expect(conflicts).toBeLessThan(knowledge);
    expect(knowledge).toBeLessThan(agents);
    const start = sidebar.indexOf("const ADMIN_VIEWS");
    const block = sidebar.slice(start, sidebar.indexOf("];", start));
    expect([...block.matchAll(/key: "([a-z]+)"/g)].map((m) => m[1])).toEqual(["agents", "tools"]);
    // Integrations have no entry: they are connected to a Nexo.
    expect(sidebar).not.toContain("<SidebarPrimitive.GroupLabel>Ingest</SidebarPrimitive.GroupLabel>");
    expect(sidebar).not.toContain('label: "Integrations"');
    // The old "Views" section label is gone.
    expect(sidebar).not.toContain("<SidebarPrimitive.GroupLabel>Views</SidebarPrimitive.GroupLabel>");
  });

  it("Knowledge starts with Brain (the graph, BrainCircuit icon), then Tasks, Roadmap, Browse, Credentials", () => {
    const sidebar = read("./sidebar.tsx");
    const start = sidebar.indexOf("const KNOWLEDGE_VIEWS");
    const block = sidebar.slice(start, sidebar.indexOf("];", start));
    const keys = [...block.matchAll(/key: "([a-z]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["graph", "tasks", "roadmap", "browse", "credentials"]);
    expect(block).toContain('{ key: "graph", label: "Brain", Icon: BrainCircuit }');
    expect(sidebar).not.toContain('label: "Graph"');
  });

  it("Tags and Decisions left the sidebar: the taxonomy is a focus inside Brain, Decisions is gone", () => {
    const sidebar = read("./sidebar.tsx");
    const viewShell = read("../lib/view-shell.ts");
    const graphView = read("./graph-view.tsx");
    expect(sidebar).not.toContain('label: "Tags"');
    expect(sidebar).not.toContain('label: "Decisions"');
    // Neither slug is a system view any more — /v/tags and /v/decisions fall
    // through to "this view is not available".
    expect(viewShell).not.toContain('"tags",');
    expect(viewShell).not.toContain('"decisions",');
    expect(viewShell).not.toContain("tagViewPath");
    // Brain owns the taxonomy: the focus switcher plus tag authoring.
    expect(graphView).toContain('<Tabs.Tab id="knowledge"');
    expect(graphView).toContain('<Tabs.Tab id="tags"');
    expect(graphView).toContain("buildTagFocusSnapshot");
    expect(graphView).toContain("<TagManager");
    expect(graphView).toContain("<AddTagModal");
  });

  it("badges Nexos with the open inbox and Conflicts with the open conflicts", () => {
    const sidebar = read("./sidebar.tsx");
    expect(sidebar).toContain("/api/nexos/inbox?workspace=");
    expect(sidebar).toContain("/api/nexo/conflicts?workspace_id=");
    expect(sidebar).toContain("<CountChip count={openInbox}");
    expect(sidebar).toContain("<CountChip count={openConflicts}");
    expect(sidebar).toContain("SidebarPrimitive.MenuChip");
    // Review is gone from the sidebar; its slug only redirects.
    expect(sidebar).not.toContain('label: "Review"');
  });

  it("no custom (saved) views in the sidebar: no list, no Add view, no editor", () => {
    const sidebar = read("./sidebar.tsx");
    expect(sidebar).not.toContain("customViews.map");
    expect(sidebar).not.toContain('aria-label="Add view"');
    expect(sidebar).not.toContain("openEditor(");
    expect(sidebar).not.toContain("ViewEditorDialog");
    expect(sidebar).not.toContain("CustomViewMenuItem");
    expect(sidebar).not.toContain("privateViews.map");
    expect(sidebar).not.toContain("publicViews.map");
  });

  it("keeps Activity in the user menu, wired from the sidebar footer", () => {
    const sidebar = read("./sidebar.tsx");
    const userMenu = read("./user-menu.tsx");
    expect(sidebar).not.toContain("<SidebarPrimitive.MenuLabel>Activity</SidebarPrimitive.MenuLabel>");
    expect(userMenu).toContain('id="activity"');
    expect(userMenu).toContain("onOpenActivity");
    expect(sidebar).toContain('onOpenActivity={() => navigate(systemViewPath(address, "changes"))}');
  });

  it("legacy slugs redirect: review → conflicts; ingest and integrations → the general Nexo; agents and tools render", () => {
    const page = read("../app/w/[org]/[ws]/v/[view]/page.tsx");
    expect(page).toContain('review: (ws) => systemViewPath(ws, "conflicts")');
    expect(page).not.toContain("agents: (ws)");
    expect(page).not.toContain("tools: (ws)");
    expect(page).toContain('new Set<WorkspaceAdminSurface>(["agents", "tools", "conflicts"])');
    expect(page).toContain('ingest: (ws) => nexoDetailPath(ws, "general", { tab: "setup", section: "sources" })');
    expect(page).toContain("redirect(legacy(address))");
  });
});
