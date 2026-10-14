/**
 * Activity feed entries, as the API returns them and the UI renders them.
 *
 * Part of the contract between bcontext-api and bcontext-web. The
 * computation lives in `@/lib/activity` on the API side; the web side only
 * ever sees these shapes, over HTTP.
 */
import type { ChangeProvenance, ChangeRelation, ChangeReview, ChangeSnapshot } from "./changes.js";
import type { NodeKind } from "./types.js";

export type ActivityKind =
  | "create"
  | "update"
  | "delete"
  | "agent"
  | "rename"
  | "move"
  | "workspace";

/**
 * Who made a change, resolved to something a person or an agent can read.
 * `id` is the durable identity (the agent id for agent writes, the auth user
 * id for human ones) and `name` is its display name — the agent's name as
 * registered in the workspace, or a labelled fallback when nothing better is
 * known. Never a bare hash.
 */
export interface ChangeActor {
  kind: "human" | "agent" | "system" | null;
  id: string | null;
  name: string;
}

export interface ActivityEntry {
  id: string;
  ts: string;
  kind: ActivityKind;
  action: string;
  node_id: string | null;
  node_title: string | null;
  node_kind: NodeKind | null;
  block_id: string | null;
  summary: string | null;
  actor_kind: "human" | "agent" | "system" | null;
  actor_id: string | null;
  actor_principal_id: string | null;
  actor_label: string;
  /** Structured form of `actor_kind` / `actor_principal_id` / `actor_label`. */
  actor: ChangeActor;
  correlation_id: string | null;
  source: string | null;
  tag_ids: string[];
  tag_slugs: string[];
  before: ChangeSnapshot | null;
  after: ChangeSnapshot | null;
  snapshot_state: "available" | "not_recorded" | "redacted";
  /**
   * This change touched the North Star or a company goal — what everything
   * else in the workspace is measured against. Derived from the snapshot, so
   * it is true of entries written before the flag existed, and it says nothing
   * about permission: `goals:write` decides who MAY, this decides who HEARS.
   */
  strategic: boolean;
  affected_relations: ChangeRelation[];
  provenance: ChangeProvenance;
  review: ChangeReview | null;
  revert: { available: boolean; reason: string };
  audit: {
    id: string;
    action: string;
    row_hash: string;
    input_hash: string | null;
    output_hash: string | null;
  } | null;
}
