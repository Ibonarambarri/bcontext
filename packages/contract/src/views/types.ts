/**
 * Saved-view records as the API returns them (`SavedView`), the principal a
 * view is resolved for, and the resolver's result — the node ids a query
 * matched plus the scope/cost report that says whether it was truncated.
 */
import type { ViewPresentation, ViewQuery } from "./schema.js";

export type ViewKind = "system" | "custom";
export type ViewVisibility = "private" | "workspace";

export interface SavedView {
  id: string;
  workspace_id: string;
  system_key: string | null;
  name: string;
  slug: string;
  description: string | null;
  kind: ViewKind;
  visibility: ViewVisibility;
  owner_id: string | null;
  owner_token_id: string | null;
  query: ViewQuery;
  presentation: ViewPresentation;
  schema_version: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ViewPrincipal {
  type: "user" | "agent" | "demo";
  id: string;
  isAdmin: boolean;
  canWrite: boolean;
}

export interface ResolvedViewQuery {
  node_ids: string[];
  total: number;
  applied_filters: ViewQuery;
  scope: {
    type: "workspace" | "roots" | "neighborhood";
    workspace_id: string;
    root_node_ids: string[];
    traversed_edges: number;
    estimated_cost: number;
    truncated: boolean;
    limits: Record<string, number>;
  };
}
