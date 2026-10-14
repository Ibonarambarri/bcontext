/**
 * Server side of goals: what a goal is decided to be when it is created, and
 * how one key result moves without rewriting the node it lives on.
 *
 * The pure rules — the shape of `data`, cycles, progress, `isStrategicGoal` —
 * live in `@bcontext-dev/contract/goals` and are used from here rather than
 * restated. What is left is the part that needs the workspace: finding the
 * North Star to hang a company goal under, and the read-modify-write of
 * `data.key_results`, which is guarded exactly like subtasks because `data` is
 * patched whole and a lost race would silently drop somebody else's key result.
 */
import { z } from "zod";
import {
  goalData,
  goalProgress,
  isGoalActive,
  keyResultProgress,
  resolveTimeframe,
  type GoalData,
  type GoalScope,
  type KeyResult,
} from "@bcontext-dev/contract/goals";
import {
  GOAL_STATUSES,
  type GoalStatus,
  type KnowledgeNode,
  type NodeEdge,
} from "@bcontext-dev/contract/types";
import { ConflictError, type CreateNodeInput, type Storage } from "@/lib/storage";

export const GOAL_SCOPES = ["company", "project"] as const;

/** The relation a goal uses to push another one forward. */
export const CONTRIBUTES_TO = "contributes_to";

/**
 * The same ceiling every other in-memory pass uses. Goals need full nodes and
 * not summaries — scope, key results and the timeframe all live in `data`,
 * which the summary index drops on purpose.
 */
const SCAN_CEILING = 5000;

export class GoalError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid" | "wrong_kind",
    message: string,
  ) {
    super(message);
    this.name = "GoalError";
  }
}

function assertGoalKind(node: Pick<KnowledgeNode, "kind">): void {
  if (node.kind !== "goal") {
    throw new GoalError(
      "wrong_kind",
      `this node is a ${node.kind}, not a goal. goals_write only edits goal nodes; use nodes_write for the rest.`,
    );
  }
}

/* -- Schemas shared by MCP and REST ---------------------------------------- */

const DateOnly = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const KeyResultDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    unit: z.string().trim().max(40).nullable().optional(),
    baseline: z.number(),
    target: z.number(),
    /** Omitted, a key result starts where it is: at its baseline. */
    current: z.number().optional(),
    direction: z.enum(["increase", "decrease", "maintain"]).default("increase"),
  })
  .strict();
export type KeyResultDraft = z.infer<typeof KeyResultDraftSchema>;

export const KeyResultPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    unit: z.string().trim().max(40).nullable().optional(),
    baseline: z.number().optional(),
    target: z.number().optional(),
    current: z.number().optional(),
    direction: z.enum(["increase", "decrease", "maintain"]).optional(),
  })
  .strict();
export type KeyResultPatch = z.infer<typeof KeyResultPatchSchema>;

/**
 * A horizon as a caller may write it: a cycle label, a pair of dates, or
 * nothing. `resolveTimeframe` reduces all three to the one truth (the range),
 * so nothing downstream has to know which form was used.
 */
const GoalHorizonSchema = z
  .object({
    cycle: z.string().trim().max(20).nullable().optional(),
    start: DateOnly.nullable().optional(),
    end: DateOnly.nullable().optional(),
  })
  .partial();
export type GoalHorizon = z.infer<typeof GoalHorizonSchema>;

export const GoalStatusSchema = z.enum(GOAL_STATUSES);

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Short ids, `k` + 5 base36 chars, unique within the goal. Same reasoning as
 * subtask ids: an agent types this one to check in against it, and a UUID per
 * key result would cost more tokens than the number it addresses.
 */
function newKeyResultId(
  existing: readonly { id: string }[],
  random: () => number = Math.random,
): string {
  const taken = new Set(existing.map((kr) => kr.id));
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = "k";
    for (let i = 0; i < 5; i++) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
    if (!taken.has(id)) return id;
  }
  let n = existing.length + 1;
  while (taken.has(`k${n}`)) n += 1;
  return `k${n}`;
}

function keyResultFromDraft(
  draft: KeyResultDraft,
  existing: readonly { id: string }[],
): KeyResult {
  return {
    id: newKeyResultId(existing),
    name: draft.name,
    unit: draft.unit ?? null,
    baseline: draft.baseline,
    target: draft.target,
    current: draft.current ?? draft.baseline,
    direction: draft.direction,
  };
}

/* -- Creation -------------------------------------------------------------- */

/** The workspace's North Star (`data.root === true`), or null if none exists. */
export async function findNorthStar(storage: Storage): Promise<KnowledgeNode | null> {
  const goals = await storage.listNodes({ kinds: ["goal"], limit: SCAN_CEILING });
  return goals.find((node) => goalData(node).root === true) ?? null;
}

export interface GoalCreateShape {
  parent_id?: string | null;
  data?: Record<string, unknown> | null;
  /** A goal this one pushes forward, named on the create itself. */
  contributes_to?: string | null;
  horizon?: GoalHorizon;
  key_results?: readonly KeyResultDraft[];
  review_every?: GoalData["review_every"];
}

export interface ResolvedGoalCreate {
  parent_id: string | null;
  data: Record<string, unknown>;
  due_date: string | null;
  scope: GoalScope;
}

/**
 * Decide, ONCE, what a goal is: its scope, where it hangs, and the window it
 * is measured over.
 *
 * A goal with no parent and nothing it contributes to is a company goal —
 * nothing above it means it answers to nothing but the North Star, which is
 * where it is then parented. The answer is **persisted** in `data.scope` and
 * never re-derived on read: a `contributes_to` edge added months later during
 * some cleanup would otherwise quietly demote what the company is aiming at,
 * and the permission that guards it with it.
 */
export async function resolveGoalCreate(
  storage: Storage,
  input: GoalCreateShape,
): Promise<ResolvedGoalCreate> {
  const raw = (input.data ?? {}) as GoalData & Record<string, unknown>;
  const explicit = raw.scope;
  if (explicit !== undefined && !GOAL_SCOPES.includes(explicit)) {
    throw new GoalError("invalid", `unknown goal scope: ${String(explicit)}`);
  }
  const isRoot = raw.root === true;
  const scope: GoalScope =
    explicit ??
    (isRoot || (!input.parent_id && !input.contributes_to) ? "company" : "project");

  // The North Star is the one goal that hangs from nothing; everything else at
  // company level hangs from it, so the tree has a single trunk even when
  // nobody remembered to say so.
  let parent_id = input.parent_id ?? null;
  if (!parent_id && !isRoot && scope === "company") {
    parent_id = (await findNorthStar(storage))?.id ?? null;
  }

  const timeframe = resolveTimeframe({
    cycle: input.horizon?.cycle ?? raw.timeframe?.cycle ?? null,
    start: input.horizon?.start ?? raw.timeframe?.start ?? null,
    end: input.horizon?.end ?? null,
  });

  const keyResults: KeyResult[] = [];
  for (const draft of input.key_results ?? []) {
    keyResults.push(keyResultFromDraft(draft, keyResults));
  }

  const data: Record<string, unknown> = {
    ...raw,
    scope,
    // The END of the horizon is the node's `due_date` column, not a key in
    // here: put it in both and the two can disagree, and everything that
    // already filters by due_date would be reading the wrong one.
    timeframe: { start: timeframe.start, cycle: timeframe.cycle },
    ...(keyResults.length > 0 || Array.isArray(raw.key_results)
      ? { key_results: keyResults.length > 0 ? keyResults : (raw.key_results as KeyResult[]) }
      : {}),
    ...(input.review_every ? { review_every: input.review_every } : {}),
  };

  return { parent_id, data, due_date: timeframe.end, scope };
}

/**
 * The create input for a goal, resolved. Kept separate from
 * `resolveGoalCreate` so the REST routes and `nodes_write` can hand it their
 * own already-validated payload without restating the field mapping.
 */
export async function goalCreateInput(
  storage: Storage,
  base: CreateNodeInput,
  extra: Omit<GoalCreateShape, "parent_id" | "data"> = {},
): Promise<CreateNodeInput> {
  const resolved = await resolveGoalCreate(storage, {
    parent_id: base.parent_id,
    data: base.data,
    ...extra,
  });
  return {
    ...base,
    parent_id: resolved.parent_id,
    data: resolved.data,
    due_date: resolved.due_date,
  };
}

/* -- Writes ---------------------------------------------------------------- */

export type GoalWriteOp =
  /** Move ONE key result, and say how the goal is doing while you are there. */
  | { op: "checkin"; key_result_id: string; current: number; status?: GoalStatus }
  | { op: "add_kr"; kr: KeyResultDraft }
  | { op: "update_kr"; key_result_id: string; kr: KeyResultPatch }
  | { op: "remove_kr"; key_result_id: string };

export interface GoalWriteResult {
  before: KnowledgeNode;
  node: KnowledgeNode;
  key_results: KeyResult[];
  key_result: KeyResult | null;
  changed: boolean;
  summary: string;
}

/** How many times an unpinned write retries against a fresh read. */
const RETRIES_WHEN_UNPINNED = 4;

function applyGoalOp(
  node: KnowledgeNode,
  op: GoalWriteOp,
  now: string,
): { data: GoalData; keyResults: KeyResult[]; keyResult: KeyResult | null; status?: GoalStatus; summary: string } {
  const data = goalData(node);
  const keyResults = [...(data.key_results ?? [])];
  const indexOf = (id: string) => {
    const index = keyResults.findIndex((kr) => kr.id === id);
    if (index < 0) {
      throw new GoalError(
        "not_found",
        `key result not found: ${id}. Known: ${keyResults.map((kr) => `${kr.id} (${kr.name})`).join(", ") || "none"}`,
      );
    }
    return index;
  };

  switch (op.op) {
    case "checkin": {
      const index = indexOf(op.key_result_id);
      const updated = { ...keyResults[index]!, current: op.current };
      keyResults[index] = updated;
      return {
        data: { ...data, key_results: keyResults, last_reviewed_at: now },
        keyResults,
        keyResult: updated,
        status: op.status,
        summary: `${updated.name}: ${op.current}${updated.unit ? ` ${updated.unit}` : ""}`,
      };
    }
    case "add_kr": {
      const created = keyResultFromDraft(op.kr, keyResults);
      keyResults.push(created);
      return { data: { ...data, key_results: keyResults }, keyResults, keyResult: created, summary: `+ ${created.name}` };
    }
    case "update_kr": {
      const index = indexOf(op.key_result_id);
      const updated = { ...keyResults[index]!, ...op.kr, unit: op.kr.unit ?? keyResults[index]!.unit };
      keyResults[index] = updated;
      return { data: { ...data, key_results: keyResults }, keyResults, keyResult: updated, summary: updated.name };
    }
    case "remove_kr": {
      const index = indexOf(op.key_result_id);
      const [removed] = keyResults.splice(index, 1);
      return { data: { ...data, key_results: keyResults }, keyResults, keyResult: removed ?? null, summary: `- ${removed?.name ?? op.key_result_id}` };
    }
  }
}

/**
 * One guarded read-modify-write against a goal.
 *
 * `data` is patched whole, so every edit in here has to read first, and an
 * unguarded write would drop a key result somebody else added in between. When
 * the caller pinned `if_updated_at` their read is the contract and a mismatch
 * is a 409; when they did not, a lost race is retried against a fresh read —
 * "the revenue KR is at 42 now" means the same thing whatever else changed on
 * the node, and charging an agent a round-trip for a concurrent title edit is
 * charging it for nothing.
 */
async function guardedGoalWrite<T>(
  storage: Storage,
  nodeId: string,
  build: (before: KnowledgeNode) => { patch: Record<string, unknown>; result: T },
  opts: { ifUpdatedAt?: string },
): Promise<{ before: KnowledgeNode; node: KnowledgeNode; result: T }> {
  for (let attempt = 0; ; attempt++) {
    const before = await storage.getNode(nodeId);
    if (!before) throw new GoalError("not_found", `node not found: ${nodeId}`);
    assertGoalKind(before);
    const { patch, result } = build(before);
    const guard = opts.ifUpdatedAt ?? before.updated_at;
    try {
      const node = await storage.updateNode(nodeId, patch, { ifUpdatedAt: guard });
      if (!node) throw new GoalError("not_found", `node not found: ${nodeId}`);
      return { before, node, result };
    } catch (err) {
      const lostRace =
        err instanceof ConflictError && !opts.ifUpdatedAt && attempt < RETRIES_WHEN_UNPINNED;
      if (!lostRace) throw err;
    }
  }
}

/** Move one key result — or add, edit, drop one — without touching the body. */
export async function writeGoalOp(
  storage: Storage,
  nodeId: string,
  op: GoalWriteOp,
  opts: { ifUpdatedAt?: string } = {},
): Promise<GoalWriteResult> {
  const { before, node, result } = await guardedGoalWrite(
    storage,
    nodeId,
    (current) => {
      const applied = applyGoalOp(current, op, new Date().toISOString());
      return {
        patch: {
          data: { ...current.data, ...applied.data },
          ...(applied.status ? { status: applied.status } : {}),
        },
        result: applied,
      };
    },
    opts,
  );
  return {
    before,
    node,
    key_results: result.keyResults,
    key_result: result.keyResult,
    changed: true,
    summary: result.summary,
  };
}

export interface GoalUpdateInput {
  title?: string;
  status?: GoalStatus;
  horizon?: GoalHorizon;
  review_every?: GoalData["review_every"];
  tag_ids?: string[];
}

/**
 * Edit what a goal IS, as opposed to how it is doing.
 *
 * `scope` is not here on purpose: it is decided once, at creation, and a goal
 * that could be promoted from a project to the company by an ordinary update
 * would make the permission that guards company goals a formality. Promotion
 * is a `nodes_write` data patch, which the storage seam gates on `goals:write`.
 */
export async function updateGoal(
  storage: Storage,
  nodeId: string,
  input: GoalUpdateInput,
  opts: { ifUpdatedAt?: string } = {},
): Promise<{ before: KnowledgeNode; node: KnowledgeNode; changed: string[] }> {
  const { before, node, result } = await guardedGoalWrite(
    storage,
    nodeId,
    (current) => {
      const data = goalData(current);
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.status !== undefined) patch.status = input.status;
      if (input.tag_ids !== undefined) patch.tag_ids = input.tag_ids;

      const movesHorizon =
        input.horizon !== undefined &&
        (input.horizon.cycle !== undefined ||
          input.horizon.start !== undefined ||
          input.horizon.end !== undefined);
      let nextData: Record<string, unknown> | null = null;
      if (movesHorizon) {
        // A cycle given alone re-derives both ends; dates given alone drop the
        // label unless they happen to land on a quarter. Falling back to the
        // stored values means "move the end to June" does not silently erase
        // the start nobody restated.
        const horizon = input.horizon!;
        const timeframe = resolveTimeframe({
          cycle: horizon.cycle !== undefined ? horizon.cycle : null,
          start: horizon.start !== undefined ? horizon.start : (data.timeframe?.start ?? null),
          end:
            horizon.end !== undefined
              ? horizon.end
              : current.due_date
                ? current.due_date.slice(0, 10)
                : null,
        });
        nextData = { ...current.data, timeframe: { start: timeframe.start, cycle: timeframe.cycle } };
        patch.due_date = timeframe.end;
      }
      if (input.review_every !== undefined) {
        nextData = { ...(nextData ?? current.data), review_every: input.review_every };
      }
      if (nextData) patch.data = nextData;
      return { patch, result: Object.keys(patch) };
    },
    opts,
  );
  return { before, node, changed: result };
}

/* -- Reads ----------------------------------------------------------------- */

export type GoalPace = "ahead" | "on_pace" | "behind";

export interface GoalHealth {
  status: GoalStatus | null;
  /** 0..1 across the measurable key results, null when none are. */
  progress: number | null;
  /** 0..1 of the horizon spent, null when the horizon is open-ended. */
  elapsed: number | null;
  /**
   * Progress against time. Null unless both are known — a goal with no
   * horizon is not "behind", it is unmeasured, and saying otherwise would put
   * a red badge on every goal nobody dated.
   */
  pace: GoalPace | null;
  active: boolean;
}

/** How far into the horizon today is, 0..1; null when it is not bounded. */
function elapsedFraction(start: string | null, end: string | null, today: string): number | null {
  if (!start || !end) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  const now = Date.parse(today);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return Math.min(1, Math.max(0, (now - from) / (to - from)));
}

/** Wider than a rounding error: below this, progress and time are level. */
const PACE_TOLERANCE = 0.1;

/**
 * Progress from key results, elapsed time from the timeframe, and the pace
 * verdict comparing the two (within `PACE_TOLERANCE` counts as on track).
 * `today` is passed in so the verdict is deterministic in tests.
 */
export function goalHealth(node: KnowledgeNode, today: string): GoalHealth {
  const data = goalData(node);
  const progress = goalProgress(data.key_results);
  const elapsed = elapsedFraction(
    data.timeframe?.start ?? null,
    node.due_date ? node.due_date.slice(0, 10) : null,
    today,
  );
  const pace: GoalPace | null =
    progress === null || elapsed === null
      ? null
      : progress - elapsed > PACE_TOLERANCE
        ? "ahead"
        : elapsed - progress > PACE_TOLERANCE
          ? "behind"
          : "on_pace";
  return {
    status: (node.status as GoalStatus | null) ?? null,
    progress,
    elapsed,
    pace,
    active: isGoalActive(node, today),
  };
}

export interface GoalCard {
  id: string;
  title: string;
  slug: string;
  scope: GoalScope | null;
  root: boolean;
  parent_id: string | null;
  due_date: string | null;
  cycle: string | null;
  start: string | null;
  last_reviewed_at: string | null;
  health: GoalHealth;
  key_results: Array<KeyResult & { progress: number | null }>;
  /** Goals this one pushes forward, by id. Edges, not hierarchy. */
  contributes_to: string[];
  children: GoalCard[];
}

function goalCard(node: KnowledgeNode, edges: readonly NodeEdge[], today: string): GoalCard {
  const data = goalData(node);
  return {
    id: node.id,
    title: node.title,
    slug: node.slug,
    scope: data.scope ?? null,
    root: data.root === true,
    parent_id: node.parent_id,
    due_date: node.due_date,
    cycle: data.timeframe?.cycle ?? null,
    start: data.timeframe?.start ?? null,
    last_reviewed_at: data.last_reviewed_at ?? null,
    health: goalHealth(node, today),
    key_results: (data.key_results ?? []).map((kr) => ({ ...kr, progress: keyResultProgress(kr) })),
    contributes_to: edges
      .filter((edge) => edge.relation === CONTRIBUTES_TO && edge.from_node === node.id)
      .map((edge) => edge.to_node),
    children: [],
  };
}

export interface GoalsFilter {
  scope?: GoalScope;
  status?: GoalStatus;
  /** Goals whose horizon has passed (or not started) are out unless asked for. */
  include_inactive?: boolean;
  today?: string;
}

export interface GoalsRead {
  north_star: GoalCard | null;
  /** The tree, North Star first. Goals whose parent was filtered out surface as roots. */
  tree: GoalCard[];
  /** The same cards, unnested, for callers that want one goal by id. */
  flat: GoalCard[];
  total: number;
}

/**
 * Every goal that matters right now, as a tree.
 *
 * The tree is built from `parent_id` because that is the one hierarchy a node
 * has; `contributes_to` is reported per goal instead of nested, since a goal
 * may push several forward and a tree cannot hold that without duplicating it.
 */
export async function readGoals(storage: Storage, filter: GoalsFilter = {}): Promise<GoalsRead> {
  const today = filter.today ?? new Date().toISOString().slice(0, 10);
  const [goals, edges] = await Promise.all([
    storage.listNodes({ kinds: ["goal"], limit: SCAN_CEILING }),
    storage.listEdges(),
  ]);
  const kept = goals.filter((node) => {
    const data = goalData(node);
    if (filter.scope && data.scope !== filter.scope) return false;
    if (filter.status && node.status !== filter.status) return false;
    // The North Star is the frame the rest is read in: it stays even when a
    // filter would drop it, or the tree loses its trunk.
    if (!filter.include_inactive && !isGoalActive(node, today) && data.root !== true) return false;
    return true;
  });

  const cards = new Map(kept.map((node) => [node.id, goalCard(node, edges, today)]));
  const roots: GoalCard[] = [];
  for (const card of cards.values()) {
    const parent = card.parent_id ? cards.get(card.parent_id) : undefined;
    if (parent) parent.children.push(card);
    else roots.push(card);
  }
  const northStar = [...cards.values()].find((card) => card.root) ?? null;
  // North Star first: an agent reading top-down should meet the frame before
  // the goals that hang off it.
  roots.sort((a, b) => Number(b.root) - Number(a.root));
  return { north_star: northStar, tree: roots, flat: [...cards.values()], total: cards.size };
}

/* -- Review cadence -------------------------------------------------------- */

const CADENCE_DAYS: Record<NonNullable<GoalData["review_every"]>, number> = {
  weekly: 7,
  monthly: 30,
  quarterly: 91,
};

const DAY_MS = 86_400_000;

export interface ReviewStatus {
  every: NonNullable<GoalData["review_every"]>;
  /** When it was last checked in on; null when it never has been. */
  last_reviewed_at: string | null;
  /** Days past the cadence. Always > 0 — an on-time goal returns null. */
  days_overdue: number;
}

/**
 * Is this goal past the cadence it promised?
 *
 * Deliberately NOT built on `computeStalenessScore` (`@/lib/rag/staleness`),
 * which is the other "is this out of date?" in the codebase. That one infers
 * decay from edit age and *halves the score for a node that is being read* —
 * the right rule for knowledge that stays true while people consult it, and
 * exactly the wrong one here: a goal being read constantly and reviewed never
 * is the failure this exists to catch, and the RAG heuristic would score it as
 * healthy. It is also fixed at 180 days and lives behind the service-role
 * client, so a brief on the demo backend could not call it at all.
 *
 * What is borrowed is the shape retrieval staleness settled on: a signal that
 * labels and ranks, never one that hides — an overdue goal stays in every list
 * it was in, carrying why.
 *
 * A goal that declared no cadence is never overdue: no promise, nothing broken.
 * One that declared a cadence and was never reviewed counts from its creation,
 * because "never reviewed" is the case worth surfacing, not the case to excuse.
 */
export function reviewStatus(
  node: Pick<KnowledgeNode, "kind" | "data" | "created_at" | "due_date">,
  today: string = new Date().toISOString().slice(0, 10),
): ReviewStatus | null {
  const data = goalData(node);
  const every = data.review_every;
  if (node.kind !== "goal" || !every) return null;
  const since = data.last_reviewed_at ?? node.created_at;
  const from = Date.parse(since);
  const now = Date.parse(today);
  if (!Number.isFinite(from) || !Number.isFinite(now)) return null;
  const elapsedDays = Math.floor((now - from) / DAY_MS);
  const overdue = elapsedDays - CADENCE_DAYS[every];
  if (overdue <= 0) return null;
  return { every, last_reviewed_at: data.last_reviewed_at ?? null, days_overdue: overdue };
}

/* -- Pressure: which goal is pulling on a piece of work --------------------- */

/**
 * How hard a goal pushes on the work under it, 0..1.
 *
 * Only distress pushes. A goal that is on track, achieved or abandoned exerts
 * nothing: if a healthy objective raised the urgency of its work, every task
 * that happens to hang off an OKR would outrank every task that does not, and
 * the queue would stop meaning "what is at risk" and start meaning "what is
 * classified".
 */
const STATUS_PRESSURE: Record<GoalStatus, number> = {
  off_track: 1,
  at_risk: 0.7,
  on_track: 0,
  achieved: 0,
  missed: 0,
  abandoned: 0,
};

/** A goal nobody has re-labelled but whose numbers trail its calendar. */
const BEHIND_PRESSURE = 0.5;
/** What the company is aiming at outranks what one project is aiming at. */
const COMPANY_BUMP = 0.15;

export interface GoalPressure {
  /** The goal the urgency comes FROM — not necessarily the one linked to. */
  goal_id: string;
  title: string;
  status: GoalStatus | null;
  urgency: number;
}

function ownPressure(node: KnowledgeNode, today: string): number {
  const health = goalHealth(node, today);
  // A goal outside its window pushes nothing: last quarter's emergency is not
  // this quarter's, and a goal that has not started cannot be behind.
  if (!health.active) return 0;
  const fromStatus = health.status ? (STATUS_PRESSURE[health.status] ?? 0) : 0;
  const base = Math.max(fromStatus, health.pace === "behind" ? BEHIND_PRESSURE : 0);
  if (base === 0) return 0;
  const data = goalData(node);
  const strategic = data.root === true || data.scope === "company";
  return Math.min(1, base + (strategic ? COMPANY_BUMP : 0));
}

/**
 * Every node's most urgent goal, followed upward.
 *
 * A node pushes the goals it `contributes_to` AND the goal it hangs under —
 * one rule for tasks and goals alike, because both forms say the same thing
 * and a workspace that used the other one would get no signal at all. It is
 * transitive: a task on a project goal that feeds a company goal in trouble
 * inherits the company goal's urgency, and the pressure is reported against
 * the goal it actually came from, so the queue can say why.
 *
 * Cycles are possible (nothing stops two goals contributing to each other) and
 * are walked once with a seen-set rather than rejected: an unanswerable
 * ordering question must not be able to hang a brief.
 */
export function indexGoalPressure(
  goals: readonly KnowledgeNode[],
  edges: readonly NodeEdge[],
  nodes: readonly Pick<KnowledgeNode, "id" | "parent_id">[],
  today: string = new Date().toISOString().slice(0, 10),
): Map<string, GoalPressure> {
  const goalById = new Map(goals.map((goal) => [goal.id, goal]));
  const contributesTo = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.relation !== CONTRIBUTES_TO) continue;
    contributesTo.set(edge.from_node, [...(contributesTo.get(edge.from_node) ?? []), edge.to_node]);
  }

  const goalsAbove = (id: string, parentId: string | null): string[] => {
    const above = (contributesTo.get(id) ?? []).filter((target) => goalById.has(target));
    if (parentId && goalById.has(parentId)) above.push(parentId);
    return above;
  };

  const resolved = new Map<string, GoalPressure | null>();
  const walking = new Set<string>();
  const effective = (goalId: string): GoalPressure | null => {
    const cached = resolved.get(goalId);
    if (cached !== undefined) return cached;
    // Back edge: this branch contributes nothing rather than recursing
    // forever. Inside a cycle there is no right answer to give — the graph is
    // saying two goals push each other — so the guarantee here is only that
    // the walk terminates and the rest of the tree is unaffected.
    if (walking.has(goalId)) return null;
    const goal = goalById.get(goalId);
    if (!goal) return null;
    walking.add(goalId);
    let best: GoalPressure = {
      goal_id: goal.id,
      title: goal.title,
      status: (goal.status as GoalStatus | null) ?? null,
      urgency: ownPressure(goal, today),
    };
    for (const above of goalsAbove(goal.id, goal.parent_id)) {
      const inherited = effective(above);
      if (inherited && inherited.urgency > best.urgency) best = inherited;
    }
    walking.delete(goalId);
    resolved.set(goalId, best);
    return best;
  };

  const pressure = new Map<string, GoalPressure>();
  for (const node of nodes) {
    // A goal is a node too, and answers for itself: the brief wants to say
    // "this objective is the one in trouble", not only which task feels it.
    let best: GoalPressure | null = goalById.has(node.id) ? effective(node.id) : null;
    for (const above of goalsAbove(node.id, node.parent_id)) {
      const candidate = effective(above);
      if (candidate && (!best || candidate.urgency > best.urgency)) best = candidate;
    }
    if (best) pressure.set(node.id, best);
  }
  return pressure;
}
