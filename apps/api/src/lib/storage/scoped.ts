/**
 * A `Storage` narrowed to what a grant allows.
 *
 * This is the single point where reach is applied. Routes do not filter; they
 * receive a storage that cannot see — or touch — past the grant, so forgetting
 * to filter is not a thing a route can do.
 *
 * ## Why a Proxy and not a hand-written wrapper
 *
 * `Storage` has 22 methods today. A wrapper that lists them one by one is
 * correct exactly until someone adds the 23rd, and the failure mode of that
 * omission is a method that quietly returns unfiltered rows. So every method is
 * classified up front and the Proxy **throws on anything unclassified**: adding
 * a method to the interface without deciding what it does about reach breaks
 * loudly at the first call, and `scoped.test.ts` breaks even earlier.
 *
 * ## Reach binds writes too
 *
 * An earlier version checked verbs on mutations and let them straight through.
 * That gave a principal narrowed to `finanzas` the ability to delete anything in
 * the workspace — it just could not read it back — and made the deny sentinel,
 * which denies every read, leave every write unrestricted. Mutations that name
 * an existing node now prove that node is in reach first, and a node out of
 * reach is reported as missing rather than forbidden, exactly as reads do.
 *
 * ## What reach does and does not cover
 *
 * Reach narrows *node* access. It deliberately does not narrow the tag
 * taxonomy: tag names carry no tenant content, every member can already see
 * them, and a principal that cannot enumerate tags cannot be given a
 * comprehensible reason why a filter returns nothing. Tag *mutations* are gated
 * by verb instead.
 *
 * ## One class of node needs more than `write`
 *
 * A goal that steers the company — the North Star and every company-scope goal
 * — takes `goals:write` on top of the verb the write would otherwise need. It
 * is enforced here, at the seam, and not in the routes or the tools, for the
 * reason the rest of this file exists: the permission belongs to the principal,
 * not to the channel, and a rule that each write path has to remember is a rule
 * the next write path will not.
 */
import { hasVerb, type Grant, type Verb } from "@/lib/auth/grants";
import { redactCredentialForAgents } from "@/lib/credentials";
import { goalData, isStrategicGoal } from "@bcontext-dev/contract/goals";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { collectSubtreeIds } from "./index";
import type { NodeEdge, Storage } from "./index";

export class ForbiddenError extends Error {
  constructor(readonly verb: Verb) {
    super(`missing verb: ${verb}`);
    this.name = "ForbiddenError";
  }
}

/** Node reads whose results must be filtered down to the reach. */
const FILTERED_NODE_READS = new Set(["listNodes", "listNodeSummaries"]);

/**
 * Node reads whose arguments are positional rather than an options object —
 * `listNodeContext(id, limit)`. They are filtered on the way out and their
 * arguments are left alone: widening a limit here would mean spreading over a
 * string and sending an object where the RPC expects a node id.
 */
const FILTERED_POSITIONAL_READS = new Set(["listNodeContext"]);

/** Single-node read: outside the reach behaves as not found, never as denied. */
const SINGLE_NODE_READS = new Set(["getNode"]);

/**
 * Reads that carry no node content and stay unfiltered.
 *
 * `countTagUsage` is a known side channel: counts include out-of-reach nodes.
 * Left open because those numbers are already on every member's tag sidebar and
 * closing it means recomputing counts per principal — worth doing once reaches
 * are narrowed in anger, not before.
 */
const UNFILTERED_READS = new Set([
  "listTags",
  "getTag",
  "resolveTagIds",
  "listTagRelations",
  "countTagUsage",
]);

/** Edge reads: kept, but narrowed to edges with both endpoints in reach. */
const FILTERED_EDGE_READS = new Set(["listEdges"]);

/**
 * Mutations that name an existing node, with the verb they require and the
 * argument position holding the node id. The id must be in reach.
 */
const NODE_WRITES = new Map<string, { verb: Verb; idArg: number }>([
  ["updateNode", { verb: "write", idArg: 0 }],
  ["deleteNode", { verb: "delete", idArg: 0 }],
  ["setNodeTags", { verb: "write", idArg: 0 }],
]);

/**
 * Mutations carrying a `parent_id` that must itself be in reach.
 *
 * Reparenting an in-reach node under an out-of-reach one mutates that node's
 * subtree, and the error it returns distinguishes "exists in this workspace"
 * from "does not". By the same argument the module already applies to edge
 * endpoints, a parent is a reference to another node and gets the same check.
 */
const PARENT_BEARING_WRITES = new Map<string, { verb: Verb; argIndex: number }>([
  ["createNode", { verb: "write", argIndex: 0 }],
]);

/** Edge mutations: both endpoints must be in reach. */
const EDGE_WRITES = new Map<string, Verb>([
  ["createEdge", "write"],
  ["deleteEdge", "write"],
]);

/**
 * Mutations gated by verb alone.
 *
 * `createNode` is here on purpose: a new node has no id to check. A principal
 * with a narrow reach can therefore create a node it will not be able to read
 * back unless it tags it into its own reach. That is odd but not a leak, and
 * enforcing "you may only create inside your reach" needs the tag assignment to
 * be part of creation, which it is not today.
 */
const VERB_ONLY_WRITES = new Map<string, Verb>([
  ["createTag", "tags:create"],
  ["updateTag", "tags:update"],
  // Merging rewrites the classification of everything that hung off the
  // absorbed tag — destructive in effect, whatever it is called. And when
  // reaches are expressed in tags, it rewrites other principals' reaches.
  ["mergeTags", "tags:delete"],
  ["deleteTag", "tags:delete"],
  ["createTagRelations", "tags:update"],
  ["deleteTagRelation", "tags:update"],
]);

/** Properties that are data, not behaviour. */
const PASSTHROUGH_PROPS = new Set(["backend", "workspace"]);

/**
 * Protocol members that must resolve to `undefined` rather than throw.
 *
 * `then` is the one that matters: the promise resolution procedure reads `.then`
 * off any value a promise resolves to, so throwing here makes
 * `async function …( ) { return scopedStorage(…) }` *reject* — and `getStorage()`
 * is already async, so that is precisely the shape the wiring will take. The
 * error surfaces from inside promise machinery as "then is not classified",
 * which points nowhere near the cause. `toJSON` has the same problem for any
 * `JSON.stringify` of a storage, usually in an error path.
 */
const PROTOCOL_MEMBERS = new Set(["then", "catch", "finally", "toJSON"]);

/**
 * Exposed on a scoped storage so callers that legitimately bypass its methods —
 * a cross-request cache that must stay shared between principals — can still
 * apply the reach to what they got back.
 */
const REACH_FILTER = Symbol.for("bcontext.reachFilter");
const REACH_IDS = Symbol.for("bcontext.reachIds");

type ReachFilter = <T extends { id: string }>(rows: T[]) => Promise<T[]>;

/**
 * The ids `storage` may reach, or `null` if unrestricted.
 *
 * For retrieval, which cannot filter after the fact: a vector search has to be
 * given its candidate boundary up front, because the content leaks through the
 * cited snippets long before anyone looks at the node list. The credential
 * exclusion already proved this — it needs two independent filters precisely
 * because the BM25 fallback and the graph expansion read `content_md` directly
 * and never pass through the vector filter.
 */
export async function reachableIdsOf(storage: Storage): Promise<Set<string> | null> {
  const ids = (storage as unknown as Record<symbol, (() => Promise<Set<string> | null>) | undefined>)[
    REACH_IDS
  ];
  return ids ? ids() : null;
}

export const CLASSIFIED_METHODS: readonly string[] = [
  ...FILTERED_NODE_READS,
  ...FILTERED_POSITIONAL_READS,
  ...SINGLE_NODE_READS,
  ...UNFILTERED_READS,
  ...FILTERED_EDGE_READS,
  ...NODE_WRITES.keys(),
  ...PARENT_BEARING_WRITES.keys(),
  ...EDGE_WRITES.keys(),
  ...VERB_ONLY_WRITES.keys(),
];

/**
 * Narrow `rows` to what `storage` may see. A storage with no reach attached is
 * a system storage and passes everything through, which is why the caches that
 * use this must be handed the *caller's* storage and never one they built
 * themselves.
 */
export async function filterToReach<T extends { id: string }>(
  storage: Storage,
  rows: T[],
): Promise<T[]> {
  return filterToReachBy(storage, rows, (row) => row.id);
}

/**
 * Narrow rows that are *about* a node without being one — activity entries,
 * for instance, whose own id identifies the event rather than the node.
 *
 * `nodeIdOf` returning null means the row is not about a node at all (a
 * workspace-level event) and passes through. A row about a node the principal
 * cannot reach is dropped, including when that node no longer exists: a deleted
 * node has no tags left to test, so it cannot be shown to be in reach, and
 * showing it anyway would leak exactly the content the reach was meant to hide.
 * Principals with an unrestricted reach see everything, so the ordinary case is
 * untouched.
 */
export async function filterToReachBy<T>(
  storage: Storage,
  rows: T[],
  nodeIdOf: (row: T) => string | null,
): Promise<T[]> {
  const filter = (storage as unknown as Record<symbol, ReachFilter | undefined>)[
    REACH_FILTER
  ];
  if (!filter) return rows;

  const withIds = rows.map((row, index) => ({ id: nodeIdOf(row) ?? `__none__${index}`, index }));
  const kept = await filter(withIds);
  const keptIndexes = new Set(kept.map((r) => r.index));
  return rows.filter((row, index) => nodeIdOf(row) === null || keptIndexes.has(index));
}

const REACH_CEILING = 5000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A reach may name tags by id or by slug, and the storage resolves the two
 * differently: `tagSlugs` is matched against slugs and aliases only, so a raw
 * UUID passed there matches nothing at all — silently, with no error, leaving
 * the principal seeing zero nodes.
 *
 * That matters because the id form is the natural one: it is what `list_tags`
 * returns and what every other tag API takes. `resolveViewQuery` already
 * accepts both, so not splitting them here is exactly the drift that reusing
 * the view language was supposed to avoid.
 */
function splitTagRefs(refs: readonly string[]): { tagIds: string[]; tagSlugs: string[] } {
  const tagIds: string[] = [];
  const tagSlugs: string[] = [];
  for (const ref of refs) (UUID.test(ref) ? tagIds : tagSlugs).push(ref);
  return { tagIds, tagSlugs };
}

/**
 * The ids a grant can reach, or `null` for unrestricted.
 *
 * Resolved through the storage's own tag filtering, which already implements
 * downward inheritance through `tag_relations` — filtering by `finanzas`
 * reaches everything tagged with any of its descendants. Reusing it keeps the
 * reach and the saved views people already understand from drifting apart.
 *
 * `tags_any` and `tags_all` are resolved separately and intersected, because
 * merging them into one list and matching with a single mode turns
 * `(a OR b) AND c` into `a AND b AND c` — still closed, but not the reach the
 * grantor wrote.
 */
async function reachableIds(
  inner: Storage,
  grant: Grant,
): Promise<Set<string> | null> {
  if (grant.reach.type === "all") return null;

  const query = grant.reach.query;
  const anyTags = query.tags_any;
  const allTags = query.tags_all;

  if (anyTags.length === 0 && allTags.length === 0) {
    // A query reach with no tag predicate matches nothing rather than
    // everything: the deny sentinel's shape, and the safe reading of an empty
    // filter. `parseReach` rejects reach shapes that rely on other predicates,
    // so this is not silently dropping a reach someone meant to work.
    return new Set();
  }

  // Guard the ceiling *before* filtering. `listNodes` truncates to 5000 raw
  // rows and only then applies tags, so in a large workspace matching nodes
  // past the 5000th position vanish and the filtered result comes back well
  // under the ceiling — the truncation would be invisible.
  // Summaries, not full nodes: this pass exists only to detect truncation, and
  // `listNodes` selects `*` (markdown included) plus a tag join over every row.
  const total = await inner.listNodeSummaries({ limit: REACH_CEILING });
  if (total.length >= REACH_CEILING) {
    throw new Error(
      `reach resolution needs the workspace to fit under ${REACH_CEILING} nodes; ` +
        `refusing to apply a reach that may have been truncated`,
    );
  }

  const sets: Array<Set<string>> = [];
  for (const [refs, mode] of [
    [anyTags, "any"] as const,
    [allTags, "all"] as const,
  ]) {
    if (refs.length === 0) continue;
    const rows = await inner.listNodeSummaries({
      ...splitTagRefs(refs),
      tagsMatch: mode,
      limit: REACH_CEILING,
    });
    sets.push(new Set(rows.map((n) => n.id)));
  }

  const [first, ...rest] = sets;
  if (!first) return new Set();
  return rest.reduce(
    (acc, s) => new Set([...acc].filter((id) => s.has(id))),
    first,
  );
}

export interface ScopeOptions {
  /**
   * Replace every `credential` node's values with their redacted shape on the
   * way out. Set for a bearer-token principal that does not hold
   * `credentials:use`.
   *
   * It lives here, and not in the routes, for the reason the whole file
   * exists: eleven routes serialize a node today, and a redaction that each of
   * them has to remember is a redaction that the twelfth will not. Masking at
   * the door means a new route cannot leak a secret by omission — it would
   * have to ask for an unscoped storage on purpose.
   *
   * Only reads through the Proxy are masked. A storage method calling its own
   * `this.getNode` (as `updateNode` does, to merge and to check
   * `if_updated_at`) goes straight to `inner` and still sees the real values,
   * so masking cannot corrupt a write from the inside. From the outside it
   * could — a caller that read a masked node and wrote its `data` back would
   * persist the sentinel — which is why `assertNodeDataContract` refuses a
   * write whose credential values are the redaction sentinel.
   */
  maskCredentials?: boolean;
}

/**
 * Wrap `inner` so every read is confined to `grant`'s reach, every mutation of
 * an existing node proves that node is in reach, and every mutation requires
 * its verb.
 */
export function scopedStorage(inner: Storage, grant: Grant, options: ScopeOptions = {}): Storage {
  const mask = <T extends { kind?: unknown } | null | undefined>(row: T): T =>
    options.maskCredentials && row && (row as { kind?: unknown }).kind === "credential"
      ? (redactCredentialForAgents(row as { id?: string; kind: string; data?: unknown }) as T)
      : row;
  const maskRows = <T extends { kind?: unknown }>(rows: T[]): T[] =>
    options.maskCredentials ? rows.map(mask) : rows;
  // Resolved once per wrapper and shared by every call through it, so a request
  // that reads several times pays for one reach resolution.
  let idsPromise: Promise<Set<string> | null> | null = null;
  const ids = () => (idsPromise ??= reachableIds(inner, grant));

  const applyReach: ReachFilter = async (rows) => {
    const allowed = await ids();
    return allowed ? rows.filter((row) => allowed.has(row.id)) : rows;
  };

  const inReach = async (id: string): Promise<boolean> => {
    const allowed = await ids();
    return !allowed || allowed.has(id);
  };

  const requireVerb = (verb: Verb) => {
    if (!hasVerb(grant, verb)) throw new ForbiddenError(verb);
  };

  /**
   * A write that names an existing node needs `goals:write` when that node is
   * strategic today — and equally when the patch would MAKE it one. Promoting
   * a project goal to company scope, or flagging it as the North Star, is the
   * side door: the node was ordinary when the check ran and steers the company
   * once the write lands.
   *
   * A principal that already holds the verb pays nothing: the read only
   * happens when the answer could be "no".
   */
  const requireGoalsVerbForExisting = async (id: string, patch: unknown) => {
    if (hasVerb(grant, "goals:write")) return;
    const existing = await inner.getNode(id);
    if (!existing || existing.kind !== "goal") return;
    const patched = (patch as { data?: Record<string, unknown> } | undefined)?.data;
    const promotes =
      patched !== undefined && isStrategicGoal({ kind: "goal", data: patched });
    if (isStrategicGoal(existing) || promotes) throw new ForbiddenError("goals:write");
  };

  /**
   * Deleting cascades, and the database removes the descendants silently, so
   * the subtree has to be free of strategic goals and not just the node named.
   * Full nodes rather than summaries because scope lives in `data`, which the
   * summary index drops on purpose — paid only by a principal that lacks the
   * verb, and only on a delete.
   */
  const requireGoalsVerbForDelete = async (id: string) => {
    if (hasVerb(grant, "goals:write")) return;
    const all = await inner.listNodes({ limit: REACH_CEILING });
    const subtree = new Set(collectSubtreeIds(all, id));
    if (all.some((node) => subtree.has(node.id) && isStrategicGoal(node))) {
      throw new ForbiddenError("goals:write");
    }
  };

  /**
   * A goal being created. Ordinary `write` creates one only when the row says,
   * in the data it is written with, that it is a project goal: an absent scope
   * is not evidence of one — `resolveGoalCreate` turns a parentless goal into a
   * company goal — so it is refused. An inclusion list, as the grants migration
   * asks for: the shape nobody foresaw fails closed.
   */
  const requireGoalsVerbForCreate = (input: unknown) => {
    const node = input as { kind?: unknown; data?: Record<string, unknown> } | undefined;
    if (node?.kind !== "goal" || hasVerb(grant, "goals:write")) return;
    const data = goalData({ kind: "goal", data: node.data ?? {} });
    if (data.root === true || data.scope !== "project") {
      throw new ForbiddenError("goals:write");
    }
  };

  return new Proxy(inner, {
    get(target, prop, receiver) {
      // Let a caller that bypasses these methods still apply the reach.
      if (prop === REACH_FILTER) return applyReach;
      // Retrieval needs the ids themselves: a vector search must be handed its
      // candidate boundary before it runs, not filtered afterwards.
      if (prop === REACH_IDS) return ids;

      // Symbols and anything inherited from Object.prototype (toString,
      // constructor, valueOf, hasOwnProperty…) pass through untouched. They
      // carry no rows, and throwing on them turns a `console.log` or a string
      // interpolation of the storage into a 500 — usually inside an error path,
      // where it would mask the failure being reported.
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      const name = String(prop);
      if (PASSTHROUGH_PROPS.has(name)) return Reflect.get(target, prop, receiver);
      // `toJSON` cannot simply be undefined: JSON.stringify would then enumerate
      // own properties, hit `client` (the service-role client) and throw from the
      // get trap — the very failure this is meant to prevent, and from inside an
      // error path. Give it a function that returns something inert instead.
      if (name === "toJSON") {
        return () => ({ backend: inner.backend, workspace: inner.workspace, scoped: true });
      }
      if (PROTOCOL_MEMBERS.has(name)) return undefined;
      if (name in Object.prototype) return Reflect.get(target, prop, receiver);

      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== "function") {
        // Not just methods: `SupabaseStorage` holds a private `client`, which is
        // the service-role client itself. Handing it out would bypass every
        // check in this file with a property access, and the Proxy is
        // advertised as the thing that cannot be bypassed by omission.
        throw new Error(
          `scopedStorage: property "${name}" is not classified. If it is safe to ` +
            `expose, add it to PASSTHROUGH_PROPS in src/lib/storage/scoped.ts.`,
        );
      }
      const call = (args: unknown[]) =>
        (original as (...a: unknown[]) => unknown).apply(target, args);

      const nodeWrite = NODE_WRITES.get(name);
      if (nodeWrite) {
        return async (...args: unknown[]) => {
          requireVerb(nodeWrite.verb);
          const id = args[nodeWrite.idArg];
          if (typeof id === "string") {
            await requireGoalsVerbForExisting(id, args[1]);
            if (name === "deleteNode") await requireGoalsVerbForDelete(id);
          }
          // Deleting cascades to descendants, which the database removes
          // silently. Checking only the named node would let a principal
          // narrowed to `finanzas` delete a finanzas-tagged parent and destroy
          // out-of-reach children it can neither see nor name — the same
          // argument the module already makes about reparenting.
          if (name === "deleteNode" && typeof id === "string") {
            const allowed = await ids();
            if (allowed) {
              const all = await inner.listNodeSummaries({ limit: REACH_CEILING });
              const subtree = collectSubtreeIds(all, id);
              const outside = subtree.find((child: string) => !allowed.has(child));
              if (outside) throw new NodeOutOfReachError(outside);
            }
          }
          if (typeof id === "string" && !(await inReach(id))) {
            // Out of reach behaves as missing, the same as reads: a 403 here
            // would confirm the node exists.
            throw new NodeOutOfReachError(id);
          }
          // A patch may also *move* the node under a parent outside the reach,
          // which mutates that parent's subtree.
          const parentId = (args[1] as { parent_id?: unknown } | undefined)?.parent_id;
          if (typeof parentId === "string" && !(await inReach(parentId))) {
            throw new NodeOutOfReachError(parentId);
          }
          return call(args);
        };
      }

      const parentWrite = PARENT_BEARING_WRITES.get(name);
      if (parentWrite) {
        return async (...args: unknown[]) => {
          requireVerb(parentWrite.verb);
          requireGoalsVerbForCreate(args[parentWrite.argIndex]);
          const parentId = (args[parentWrite.argIndex] as { parent_id?: unknown } | undefined)
            ?.parent_id;
          if (typeof parentId === "string" && !(await inReach(parentId))) {
            throw new NodeOutOfReachError(parentId);
          }
          return call(args);
        };
      }

      const edgeVerb = EDGE_WRITES.get(name);
      if (edgeVerb) {
        return async (...args: unknown[]) => {
          requireVerb(edgeVerb);
          const edge = args[0] as NodeEdge | undefined;
          for (const endpoint of [edge?.from_node, edge?.to_node]) {
            if (typeof endpoint === "string" && !(await inReach(endpoint))) {
              throw new NodeOutOfReachError(endpoint);
            }
          }
          return call(args);
        };
      }

      const verbOnly = VERB_ONLY_WRITES.get(name);
      if (verbOnly) {
        return async (...args: unknown[]) => {
          requireVerb(verbOnly);
          return call(args);
        };
      }

      if (UNFILTERED_READS.has(name)) {
        return async (...args: unknown[]) => {
          requireVerb("read");
          return call(args);
        };
      }

      if (FILTERED_EDGE_READS.has(name)) {
        return async (...args: unknown[]) => {
          requireVerb("read");
          const edges = (await call(args)) as NodeEdge[];
          const allowed = await ids();
          if (!allowed) return edges;
          // Both endpoints must be in reach. An edge with one endpoint outside
          // still discloses that node's id and how it relates to something the
          // principal can see — enough to map the tenant's graph.
          return edges.filter(
            (e) => allowed.has(e.from_node) && allowed.has(e.to_node),
          );
        };
      }

      if (SINGLE_NODE_READS.has(name)) {
        return async (...args: unknown[]) => {
          requireVerb("read");
          const node = (await call(args)) as KnowledgeNode | null;
          if (!node) return null;
          return (await inReach(node.id)) ? mask(node) : null;
        };
      }

      if (FILTERED_POSITIONAL_READS.has(name)) {
        return async (...args: unknown[]) => {
          requireVerb("read");
          const rows = (await call(args)) as Array<{ id: string; kind?: unknown }>;
          const allowed = await ids();
          return maskRows(allowed ? rows.filter((row) => allowed.has(row.id)) : rows);
        };
      }

      if (FILTERED_NODE_READS.has(name)) {
        return async (...args: unknown[]) => {
          requireVerb("read");
          const allowed = await ids();
          if (!allowed) return maskRows((await call(args)) as Array<{ kind?: unknown }>);

          // Filter before honouring the caller's limit. Filtering after it
          // means a principal whose reachable nodes sort late asks for 20 and
          // gets 0, with no way to page further — indistinguishable from having
          // no nodes at all.
          const opts = (args[0] ?? {}) as { limit?: number };
          const limit = opts.limit ?? Number.POSITIVE_INFINITY;
          const widened = [{ ...opts, limit: REACH_CEILING }, ...args.slice(1)];
          const rows = (await call(widened)) as Array<{ id: string; kind?: unknown }>;
          return maskRows(rows.filter((row) => allowed.has(row.id))).slice(0, limit);
        };
      }

      // Unclassified. Fail loudly rather than pass rows through unfiltered —
      // the whole point of the Proxy.
      throw new Error(
        `scopedStorage: "${name}" is not classified. Decide whether it needs ` +
          `reach filtering, a verb, or neither, and add it to the sets in ` +
          `src/lib/storage/scoped.ts.`,
      );
    },
  });
}

/**
 * A mutation named a node outside the principal's reach. Carries the same
 * meaning as "not found" — callers should render it as a 404, never a 403.
 */
export class NodeOutOfReachError extends Error {
  constructor(readonly nodeId: string) {
    super(`node not found: ${nodeId}`);
    this.name = "NodeOutOfReachError";
  }
}
