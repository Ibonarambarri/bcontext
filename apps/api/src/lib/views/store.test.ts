import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { emptyViewQuery } from "@bcontext-dev/contract/views/schema";
import { createView, deleteView, duplicateView, listViews, resetDemoViewsForTests, updateView, ViewConflictError, ViewForbiddenError } from "./store";
import { systemViewSeeds } from "./seeds";

const owner = { type: "agent", id: "token-owner", isAdmin: false, canWrite: true } as const;
const other = { type: "agent", id: "token-other", isAdmin: false, canWrite: true } as const;
const admin = { type: "agent", id: "token-admin", isAdmin: true, canWrite: true } as const;
const presentation = { schema_version: 1 as const, renderer: "list" as const };

function setup() {
  const slug = `views-${Date.now()}-${Math.random()}`;
  const workspace = createWorkspace({ name: "Views", slug });
  const storage = resolveDemoStorage(workspace.slug)!;
  return storage;
}

describe("saved view store", () => {
  beforeEach(() => resetDemoViewsForTests());

  it("seeds exactly the eight canonical system views for new workspaces", async () => {
    const storage = setup();
    const views = await listViews(storage, owner);
    expect(views.filter((view) => view.kind === "system").map((view) => view.name)).toEqual(["Overview", "Graph", "Tasks", "Roadmap", "Browse", "Credentials", "Changes", "Agents"]);
    expect(systemViewSeeds(storage.workspace.id)).toHaveLength(8);
  });

  it("creates, duplicates, updates and deletes custom views without node copies", async () => {
    const storage = setup();
    const created = await createView(storage, owner, { name: "My tasks", query: { ...emptyViewQuery(), kinds: ["task"] }, presentation });
    expect(created).not.toHaveProperty("nodes");
    const copy = await duplicateView(storage, owner, created.id);
    expect(copy.id).not.toBe(created.id);
    expect(copy.query).toEqual(created.query);
    const updated = await updateView(storage, owner, created.id, { expected_version: 1, visibility: "workspace", name: "Team tasks" });
    expect(updated.version).toBe(2);
    await expect(updateView(storage, owner, created.id, { expected_version: 1, name: "stale" })).rejects.toBeInstanceOf(ViewConflictError);
    await deleteView(storage, owner, copy.id, copy.version);
    expect((await listViews(storage, owner)).some((view) => view.id === copy.id)).toBe(false);
  });

  it("enforces private ownership, admin override, viewer denial and system immutability", async () => {
    const storage = setup();
    const created = await createView(storage, owner, { name: "Private", query: emptyViewQuery(), presentation });
    expect((await listViews(storage, other)).some((view) => view.id === created.id)).toBe(false);
    await expect(updateView(storage, other, created.id, { expected_version: 1, name: "No" })).rejects.toThrow();
    await expect(updateView(storage, admin, created.id, { expected_version: 1, name: "Admin edit" })).resolves.toMatchObject({ version: 2 });
    await expect(createView(storage, { ...other, canWrite: false }, { name: "Viewer", query: emptyViewQuery(), presentation })).rejects.toBeInstanceOf(ViewForbiddenError);
    const system = (await listViews(storage, owner))[0]!;
    await expect(updateView(storage, admin, system.id, { expected_version: 1, name: "No" })).rejects.toBeInstanceOf(ViewForbiddenError);
  });
});
