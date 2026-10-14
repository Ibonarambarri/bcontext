/**
 * Which body and which identity-strip properties the floating node panel
 * gives each node kind. Pure and exhaustive: `PLANS` is a `Record` over
 * every `NodeKind`, so adding a kind to the contract fails typecheck here
 * until the panel says what that kind looks like — a new kind can never
 * silently fall through to a generic body. `panel-body.tsx` is the switch
 * that turns a plan into components; `node-inspector.tsx` reads the
 * property flags for the strip under the title.
 */
import { NODE_KINDS, type NodeKind } from "@bcontext-dev/contract/types";

export type PanelBody =
  /** Prose: the editor when the person can write, rendered Markdown otherwise. */
  | "markdown"
  /** A task or bug: dependencies, subtasks, then the body. */
  | "work"
  /** Scope, health, key results, then the body. */
  | "goal"
  /** Transcript / refined notes tabs; the notes are the editable body. */
  | "meeting"
  /** The CSV grid with raw editing. */
  | "data"
  /** Typed secret fields; no prose. */
  | "credential"
  /** Version, declared inputs and model above the prompt body. */
  | "skill"
  /** Aliases and connections first — an entity is what links to it. */
  | "entity";

export interface PanelPlan {
  body: PanelBody;
  /**
   * Which status vocabulary the strip offers, or none. `null` still shows a
   * status when the node carries one (a doc an agent gave a status should be
   * able to lose it), it just does not invite one.
   */
  status: "task" | "goal" | null;
  /** Whether the priority pill is always offered. */
  priority: boolean;
  /** Whether `blocked_by` / `blocks` are part of the body, not only Details. */
  dependencies: boolean;
  /** Whether subtasks live on this kind. */
  subtasks: boolean;
}

const PLANS: Record<NodeKind, PanelPlan> = {
  doc: { body: "markdown", status: null, priority: false, dependencies: false, subtasks: false },
  task: { body: "work", status: "task", priority: true, dependencies: true, subtasks: true },
  bug: { body: "work", status: "task", priority: true, dependencies: true, subtasks: true },
  // A decision is open until its status is terminal (`brief` lists them as
  // "open decisions"), so the strip offers the task vocabulary to close it.
  decision: { body: "markdown", status: "task", priority: false, dependencies: false, subtasks: false },
  adr: { body: "markdown", status: "task", priority: false, dependencies: false, subtasks: false },
  meeting: { body: "meeting", status: null, priority: false, dependencies: false, subtasks: false },
  entity: { body: "entity", status: null, priority: false, dependencies: false, subtasks: false },
  skill: { body: "skill", status: null, priority: false, dependencies: false, subtasks: false },
  data: { body: "data", status: null, priority: false, dependencies: false, subtasks: false },
  credential: { body: "credential", status: null, priority: false, dependencies: false, subtasks: false },
  goal: { body: "goal", status: "goal", priority: false, dependencies: false, subtasks: false },
};

export function panelPlanFor(kind: NodeKind): PanelPlan {
  return PLANS[kind];
}

/** Every kind the panel knows a plan for — the test compares it to the contract's list. */
export const PLANNED_KINDS: readonly NodeKind[] = Object.keys(PLANS) as NodeKind[];

/** Kinds whose body is the Markdown editor, alone or under a kind-specific header. */
export function panelBodyIsProse(body: PanelBody): boolean {
  return body === "markdown" || body === "work" || body === "goal" || body === "skill" || body === "entity" || body === "meeting";
}

export { NODE_KINDS };
