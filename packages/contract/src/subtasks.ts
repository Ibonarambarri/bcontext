/**
 * Subtasks — the unit of work INSIDE a task node.
 *
 * A task node is the thing the graph knows about: it has status, tags,
 * typed dependencies and an embedding. What it takes to finish that task
 * is not more nodes — a task split into five "phase" nodes gives the graph
 * five half-meaningful entries and the agent five reads. Subtasks live on
 * the task itself, in `node.data.subtasks[]`, so one read of the node
 * returns everything needed to do the work, and the graph stays a graph of
 * meaningful things.
 *
 * Each subtask carries a `title`, a `summary` (what the card shows; written
 * by whoever creates it, who has the context — never generated server-side)
 * and a full `content_md` body (what opening the card shows). Order is the
 * array order. Ids are short, stable and unique within the node, so agents
 * can address one subtask surgically instead of rewriting the task.
 *
 * Everything here is pure and shared by the API, the MCP server and the web:
 * the same `applySubtaskOp` decides what a write does on every surface.
 */
import { z } from "zod";

export const SUBTASK_LIMITS = {
  /** Subtasks per task. Past this, the task itself is too big. */
  count: 100,
  title: 200,
  summary: 600,
  content: 40_000,
} as const;

export interface Subtask {
  /** Stable within the node. Never reused after a delete. */
  id: string;
  title: string;
  /** One or two sentences the card shows; the "why open this" line. */
  summary: string;
  /** Full markdown body shown when the subtask is opened. */
  content_md: string;
  done: boolean;
  done_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The card projection: what a list of subtasks costs to read. */
export type SubtaskCard = Pick<Subtask, "id" | "title" | "summary" | "done" | "done_at">;

export interface SubtaskProgress {
  done: number;
  total: number;
}

/** What a caller supplies to create one (ids and stamps are ours). */
export const SubtaskDraftSchema = z.object({
  title: z.string().trim().min(1).max(SUBTASK_LIMITS.title),
  summary: z.string().trim().max(SUBTASK_LIMITS.summary).default(""),
  content_md: z.string().max(SUBTASK_LIMITS.content).default(""),
}).strict();
export type SubtaskDraft = z.infer<typeof SubtaskDraftSchema>;

export const SubtaskPatchSchema = z.object({
  title: z.string().trim().min(1).max(SUBTASK_LIMITS.title).optional(),
  summary: z.string().trim().max(SUBTASK_LIMITS.summary).optional(),
  content_md: z.string().max(SUBTASK_LIMITS.content).optional(),
}).strict();
export type SubtaskPatch = z.infer<typeof SubtaskPatchSchema>;

/**
 * One write against a task's subtasks. Shared verbatim by
 * `subtasks_write` (MCP) and `POST /api/nodes/:id/subtasks` (REST).
 */
export const SubtaskOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    title: z.string().trim().min(1).max(SUBTASK_LIMITS.title),
    summary: z.string().trim().max(SUBTASK_LIMITS.summary).default(""),
    content_md: z.string().max(SUBTASK_LIMITS.content).default(""),
    /** 0-based index to insert at; omit to append. */
    position: z.number().int().min(0).optional(),
  }).strict(),
  z.object({
    op: z.literal("update"),
    id: z.string().min(1),
    patch: SubtaskPatchSchema,
  }).strict(),
  z.object({
    op: z.literal("delete"),
    id: z.string().min(1),
  }).strict(),
  z.object({
    op: z.literal("toggle"),
    id: z.string().min(1),
    /** Omit to flip; pass true/false to set an explicit state (idempotent). */
    done: z.boolean().optional(),
  }).strict(),
  z.object({
    op: z.literal("reorder"),
    /** The complete new order — every current id exactly once. */
    ids: z.array(z.string().min(1)).min(1).max(SUBTASK_LIMITS.count).optional(),
    /** Or move ONE subtask to a 0-based position. */
    id: z.string().min(1).optional(),
    position: z.number().int().min(0).optional(),
  }).strict(),
]);
export type SubtaskOp = z.infer<typeof SubtaskOpSchema>;

export type SubtaskOpResult =
  | {
      ok: true;
      subtasks: Subtask[];
      /** The subtask the op touched (null after a delete). */
      subtask: Subtask | null;
      /** False when the op was a no-op (e.g. toggle to the current state). */
      changed: boolean;
      summary: string;
    }
  | { ok: false; error: string };

/** Read `data.subtasks[]` defensively (missing/malformed → []). */
export function readSubtasks(
  data: Record<string, unknown> | null | undefined,
): Subtask[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as Record<string, unknown>).subtasks;
  if (!Array.isArray(raw)) return [];
  const out: Subtask[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const s = v as Partial<Subtask>;
    if (typeof s.id !== "string" || typeof s.title !== "string") continue;
    out.push({
      id: s.id,
      title: s.title,
      summary: typeof s.summary === "string" ? s.summary : "",
      content_md: typeof s.content_md === "string" ? s.content_md : "",
      done: s.done === true,
      done_at: typeof s.done_at === "string" ? s.done_at : null,
      created_at: typeof s.created_at === "string" ? s.created_at : "",
      updated_at: typeof s.updated_at === "string" ? s.updated_at : "",
    });
  }
  return out;
}

/** True when `data` carries a subtasks key at all (even an empty list). */
export function hasSubtasks(data: Record<string, unknown> | null | undefined): boolean {
  return Boolean(data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).subtasks));
}

/** `data` with `subtasks` replaced; every other key untouched. */
export function withSubtasks(
  data: Record<string, unknown> | null | undefined,
  subtasks: Subtask[],
): Record<string, unknown> {
  const base = data && typeof data === "object" ? { ...(data as Record<string, unknown>) } : {};
  base.subtasks = subtasks;
  return base;
}

/** `data` without the subtasks key — for payloads that carry them separately. */
export function withoutSubtasks(
  data: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const { subtasks: _subtasks, ...rest } = data as Record<string, unknown>;
  return rest;
}

export function subtaskCard(s: Subtask): SubtaskCard {
  return { id: s.id, title: s.title, summary: s.summary, done: s.done, done_at: s.done_at };
}

/**
 * Progress for whatever shape of node a renderer holds: a summary row carries
 * it precomputed (`subtasks`), a full node carries the list in `data`.
 * Null when there are no subtasks at all.
 */
export function nodeSubtaskProgress(
  node: { data?: Record<string, unknown> | null; subtasks?: SubtaskProgress | null },
): SubtaskProgress | null {
  if (node.subtasks !== undefined) return node.subtasks ?? null;
  if (!hasSubtasks(node.data)) return null;
  const list = readSubtasks(node.data);
  return list.length > 0 ? subtaskProgress(list) : null;
}

export function subtaskProgress(subtasks: readonly Subtask[]): SubtaskProgress {
  let done = 0;
  for (const s of subtasks) if (s.done) done += 1;
  return { done, total: subtasks.length };
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Short ids: 6 chars of base36 with an `s` prefix, unique within the node.
 * Short because agents type them; a UUID per subtask would cost more tokens
 * than the summary it addresses.
 */
export function newSubtaskId(existing: readonly { id: string }[], random: () => number = Math.random): string {
  const taken = new Set(existing.map((s) => s.id));
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = "s";
    for (let i = 0; i < 6; i++) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
    if (!taken.has(id)) return id;
  }
  // 36^6 ids and 50 collisions in a row: not random. Fall back to a counter.
  let n = existing.length + 1;
  while (taken.has(`s${n}`)) n += 1;
  return `s${n}`;
}

/** Build the initial list from creation drafts (task create with subtasks). */
export function subtasksFromDrafts(
  drafts: readonly SubtaskDraft[],
  now: string = new Date().toISOString(),
  random?: () => number,
): Subtask[] {
  const out: Subtask[] = [];
  for (const draft of drafts) {
    out.push({
      id: newSubtaskId(out, random),
      title: draft.title,
      summary: draft.summary ?? "",
      content_md: draft.content_md ?? "",
      done: false,
      done_at: null,
      created_at: now,
      updated_at: now,
    });
  }
  return out;
}

/**
 * Apply one op to a list and return the new list. Pure: the caller decides
 * how to persist and what to record. Errors are strings the caller can hand
 * straight back to an agent, and include the ids that DO exist so the retry
 * needs no extra read.
 */
export function applySubtaskOp(
  current: readonly Subtask[],
  op: SubtaskOp,
  now: string = new Date().toISOString(),
  random?: () => number,
): SubtaskOpResult {
  const known = () => current.map((s) => `${s.id} (${s.title})`).join(", ") || "none";
  const find = (id: string) => {
    const index = current.findIndex((s) => s.id === id);
    return index === -1 ? null : { index, subtask: current[index]! };
  };

  switch (op.op) {
    case "add": {
      if (current.length >= SUBTASK_LIMITS.count) {
        return { ok: false, error: `subtask_limit: a task holds at most ${SUBTASK_LIMITS.count} subtasks; split the task instead` };
      }
      const subtask: Subtask = {
        id: newSubtaskId(current, random),
        title: op.title,
        summary: op.summary ?? "",
        content_md: op.content_md ?? "",
        done: false,
        done_at: null,
        created_at: now,
        updated_at: now,
      };
      const at = op.position === undefined ? current.length : Math.min(op.position, current.length);
      const subtasks = [...current.slice(0, at), subtask, ...current.slice(at)];
      return { ok: true, subtasks, subtask, changed: true, summary: `subtask added: ${subtask.title}` };
    }
    case "update": {
      const hit = find(op.id);
      if (!hit) return { ok: false, error: `subtask not found: ${op.id}. Known: ${known()}` };
      const patch = op.patch;
      const next: Subtask = {
        ...hit.subtask,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.content_md !== undefined ? { content_md: patch.content_md } : {}),
      };
      const changed =
        next.title !== hit.subtask.title ||
        next.summary !== hit.subtask.summary ||
        next.content_md !== hit.subtask.content_md;
      if (!changed) return { ok: true, subtasks: [...current], subtask: hit.subtask, changed: false, summary: `subtask unchanged: ${hit.subtask.title}` };
      next.updated_at = now;
      const subtasks = [...current];
      subtasks[hit.index] = next;
      const renamed = next.title !== hit.subtask.title;
      return {
        ok: true,
        subtasks,
        subtask: next,
        changed: true,
        summary: renamed ? `subtask renamed: ${hit.subtask.title} → ${next.title}` : `subtask edited: ${next.title}`,
      };
    }
    case "delete": {
      const hit = find(op.id);
      if (!hit) return { ok: false, error: `subtask not found: ${op.id}. Known: ${known()}` };
      const subtasks = current.filter((s) => s.id !== op.id);
      return { ok: true, subtasks, subtask: null, changed: true, summary: `subtask removed: ${hit.subtask.title}` };
    }
    case "toggle": {
      const hit = find(op.id);
      if (!hit) return { ok: false, error: `subtask not found: ${op.id}. Known: ${known()}` };
      const done = op.done ?? !hit.subtask.done;
      if (done === hit.subtask.done) {
        return { ok: true, subtasks: [...current], subtask: hit.subtask, changed: false, summary: `subtask already ${done ? "done" : "open"}: ${hit.subtask.title}` };
      }
      const next: Subtask = { ...hit.subtask, done, done_at: done ? now : null, updated_at: now };
      const subtasks = [...current];
      subtasks[hit.index] = next;
      return { ok: true, subtasks, subtask: next, changed: true, summary: `subtask ${done ? "☑" : "☐"} ${next.title}` };
    }
    case "reorder": {
      if (op.ids) {
        const ids = op.ids;
        const currentIds = current.map((s) => s.id);
        const missing = currentIds.filter((id) => !ids.includes(id));
        const unknown = ids.filter((id) => !currentIds.includes(id));
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (missing.length || unknown.length || dupes.length) {
          return {
            ok: false,
            error:
              `reorder needs every current id exactly once` +
              (missing.length ? `; missing: ${missing.join(", ")}` : "") +
              (unknown.length ? `; unknown: ${unknown.join(", ")}` : "") +
              (dupes.length ? `; repeated: ${dupes.join(", ")}` : "") +
              `. Current order: ${currentIds.join(", ")}`,
          };
        }
        const byId = new Map(current.map((s) => [s.id, s]));
        const subtasks = ids.map((id) => byId.get(id)!);
        const changed = subtasks.some((s, i) => s.id !== currentIds[i]);
        return { ok: true, subtasks, subtask: null, changed, summary: "subtasks reordered" };
      }
      if (op.id !== undefined && op.position !== undefined) {
        const hit = find(op.id);
        if (!hit) return { ok: false, error: `subtask not found: ${op.id}. Known: ${known()}` };
        const rest = current.filter((s) => s.id !== op.id);
        const at = Math.min(op.position, rest.length);
        const subtasks = [...rest.slice(0, at), hit.subtask, ...rest.slice(at)];
        const changed = at !== hit.index;
        return { ok: true, subtasks, subtask: hit.subtask, changed, summary: `subtask moved: ${hit.subtask.title} → #${at + 1}` };
      }
      return { ok: false, error: "reorder needs either `ids` (the full order) or `id` + `position`" };
    }
  }
}
