/**
 * The system views every workspace starts with, as data.
 *
 * Postgres workspaces get these rows from the seed function in the
 * `saved_views` migration; the demo backend builds them from this list at
 * first access (`store.ts`). Keep the two in step: a key added here and not
 * there exists only in demo mode. Retired keys are hidden in `store.ts`
 * rather than deleted, so old rows need no data migration.
 */
import { emptyViewQuery, normalizeViewPresentation, normalizeViewQuery } from "@bcontext-dev/contract/views/schema";
import type { SavedView } from "@bcontext-dev/contract/views/types";

const definitions = [
  ["overview", "Overview", "list", {}, 10],
  ["graph", "Graph", "graph", {
    clustering: { by: "none" },
    layout: { graph: { mode: "query", depth: 2, layers: ["hierarchy", "taxonomy", "references", "dependencies"] } },
  }, 20],
  ["tasks", "Tasks", "board", { query: { kinds: ["bug", "task"] }, group_by: "status", sort_by: [{ field: "priority", direction: "desc" }] }, 30],
  ["roadmap", "Roadmap", "roadmap", { query: { kinds: ["bug", "task"] }, layout: { roadmap: { done_window_days: 30, rules_version: 1 } } }, 35],
  ["browse", "Browse", "browse", {}, 40],
  ["credentials", "Credentials", "credentials", { query: { kinds: ["credential"] } }, 55],
  ["changes", "Changes", "changes", { sort_by: [{ field: "updated_at", direction: "desc" }] }, 60],
  ["agents", "Agents", "table", { columns: ["name", "status"], layout: { resource: "agents" } }, 80],
] as const;

/** Ids are deterministic (`system:<workspace>:<key>`) so demo state survives re-seeding. */
export function systemViewSeeds(workspaceId: string, now = new Date().toISOString()): SavedView[] {
  return definitions.map(([key, name, renderer, options, position]) => {
    const queryOptions = "query" in options ? options.query : {};
    return {
      id: `system:${workspaceId}:${key}`,
      workspace_id: workspaceId,
      system_key: key,
      name,
      slug: key,
      description: null,
      kind: "system",
      visibility: "workspace",
      owner_id: null,
      owner_token_id: null,
      query: normalizeViewQuery({ ...emptyViewQuery(), ...queryOptions }),
      presentation: normalizeViewPresentation({
        schema_version: 1,
        renderer,
        group_by: "group_by" in options ? options.group_by : null,
        sort_by: "sort_by" in options ? options.sort_by : [],
        columns: "columns" in options ? options.columns : [],
        clustering: "clustering" in options ? options.clustering : {},
        layout: "layout" in options ? options.layout : {},
      }),
      schema_version: 1,
      version: 1,
      created_at: now,
      updated_at: now,
      position,
    } as SavedView & { position: number };
  });
}
