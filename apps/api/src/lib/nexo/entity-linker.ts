/**
 * NEXO entity linking — people, customers and products as first-class nodes.
 *
 * A cheap on-save sweep with no LLM in it: when a node's prose names an
 * `entity` node of the same workspace (by title or by one of the aliases
 * kept in `entity.data.aliases`), a `references` edge from the node to the
 * entity is proposed. "Proposed" means two different things depending on
 * how sure the match is:
 *
 *   - an exact name/alias that maps to ONE entity → the edge is created
 *     directly (idempotent, same effect as `links_write`) and the change
 *     feed records it as actor `system` ("entity linked: <name>");
 *   - a name/alias that maps to SEVERAL entities → nothing is linked and a
 *     `doubt` conflict is opened on the Conflicts surface so a human picks.
 *
 * What it never does: link a node to itself, or re-link an edge a human
 * removed. Unlinking a `references` edge onto an entity records the entity
 * in `data.entity_links_dismissed` on the source node (see
 * `rememberDismissedEntityLink`) and later sweeps leave it alone.
 *
 * Runs after the write, best effort, from `afterNodeWrite` — a failure here
 * is logged and can never fail the save that triggered it.
 */
import { log } from "@bcontext-dev/contract/log";
import { changePayload } from "@bcontext-dev/contract/changes";
import type { KnowledgeNode, NodeEdge } from "@bcontext-dev/contract/types";
import type { Storage } from "@/lib/storage";
import { record as recordActivity } from "@/lib/activity";

export const ENTITY_LINK_RELATION = "references";
/** Names shorter than this ("AI", "UX") match everywhere and mean nothing. */
const MIN_TERM_LENGTH = 3;
/** Cap on `data.entity_links_dismissed`; oldest entries drop first. */
const DISMISSED_MAX = 100;

export interface EntityRef {
  id: string;
  title: string;
  aliases: string[];
}

export interface EntityMention {
  entityId: string;
  /** The name or alias, as declared on the entity, that matched. */
  term: string;
}

export interface AmbiguousMention {
  term: string;
  entityIds: string[];
}

export interface EntityMentionScan {
  matches: EntityMention[];
  ambiguous: AmbiguousMention[];
}

/** `entity.data.aliases: string[]` — tolerant of junk. */
function readEntityAliases(data: unknown): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const raw = (data as Record<string, unknown>).aliases;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** `node.data.entity_links_dismissed: string[]` — entity ids a human unlinked. */
export function readDismissedEntityLinks(data: unknown): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const raw = (data as Record<string, unknown>).entity_links_dismissed;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
}

function toEntityRef(node: Pick<KnowledgeNode, "id" | "title" | "data">): EntityRef {
  return { id: node.id, title: node.title, aliases: readEntityAliases(node.data) };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Drop fenced and inline code before matching: an identifier that happens
 * to equal a customer's name is not a mention of the customer.
 */
export function stripCode(markdown: string): string {
  return markdown
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/**
 * Word-boundary, case-insensitive match of a term. Unicode-aware so "José"
 * and "Müller" bound correctly and "Acme" does not match "Acmeco".
 */
function termRegex(term: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(term)}(?![\\p{L}\\p{N}_])`, "iu");
}

/**
 * Pure scan: which entities does `text` mention? A term that belongs to
 * more than one entity is reported as ambiguous rather than matched. Each
 * entity is reported at most once (its first matching term).
 */
export function findEntityMentions(
  text: string,
  entities: readonly EntityRef[],
  opts: { minLength?: number; excludeId?: string | null } = {},
): EntityMentionScan {
  const minLength = opts.minLength ?? MIN_TERM_LENGTH;
  const haystack = stripCode(text);
  if (!haystack.trim()) return { matches: [], ambiguous: [] };

  // term (lowercased) → entities that declare it.
  const byTerm = new Map<string, { term: string; entityIds: string[] }>();
  for (const entity of entities) {
    for (const raw of [entity.title, ...entity.aliases]) {
      const term = raw.trim();
      if (term.length < minLength) continue;
      const key = term.toLowerCase();
      const entry = byTerm.get(key) ?? { term, entityIds: [] };
      if (!entry.entityIds.includes(entity.id)) entry.entityIds.push(entity.id);
      byTerm.set(key, entry);
    }
  }

  const matches: EntityMention[] = [];
  const ambiguous: AmbiguousMention[] = [];
  const matched = new Set<string>();
  // Longest terms first so "Acme Corp" wins over "Acme" when both exist.
  const terms = [...byTerm.values()].sort((a, b) => b.term.length - a.term.length);
  for (const { term, entityIds } of terms) {
    // A term the node itself declares names the node: an entity's own page
    // saying "Acme" is not a mention of the other Acme.
    if (opts.excludeId && entityIds.includes(opts.excludeId)) continue;
    if (!termRegex(term).test(haystack)) continue;
    if (entityIds.length > 1) {
      // Ambiguous unless every candidate was already matched unambiguously.
      const unresolved = entityIds.filter((id) => !matched.has(id));
      if (unresolved.length > 1) ambiguous.push({ term, entityIds: unresolved });
      continue;
    }
    const id = entityIds[0]!;
    if (matched.has(id)) continue;
    matched.add(id);
    matches.push({ entityId: id, term });
  }
  return { matches, ambiguous };
}

export interface LinkEntitiesResult {
  /** Entity ids newly linked by this sweep. */
  linked: string[];
  /** Entity ids mentioned but already linked or dismissed. */
  skipped: string[];
  ambiguous: AmbiguousMention[];
}

/** The activity feed keys demo workspaces by slug and Supabase ones by id (both resolve). */
function activityKey(storage: Storage): string {
  return storage.backend === "supabase" ? storage.workspace.id : storage.workspace.slug;
}

/**
 * Entities of the workspace. Supabase gets a narrow query (the hot-path
 * summaries drop `data`, so aliases would be lost, and `listNodes` hydrates
 * every node of the workspace); demo reads the in-memory store.
 */
async function loadEntities(storage: Storage): Promise<EntityRef[]> {
  if (storage.backend === "supabase") {
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    const { data, error } = await getSupabaseAdmin()
      .from("nodes")
      .select("id, title, data")
      .eq("workspace_id", storage.workspace.id)
      .eq("kind", "entity")
      .limit(2000);
    if (error) throw new Error(`entity-linker: listing entities failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string; title: string; data: unknown }>;
    return rows.map((row) =>
      toEntityRef({ id: row.id, title: row.title, data: (row.data ?? {}) as Record<string, unknown> }),
    );
  }
  return (await storage.listNodes()).filter((n) => n.kind === "entity").map(toEntityRef);
}

/**
 * Sweep one node: link every unambiguous entity mention that is not already
 * linked or dismissed, and raise a doubt for ambiguous ones. Safe to call
 * repeatedly — the edge write is idempotent and the feed only records new
 * links.
 */
export async function linkEntities(
  storage: Storage,
  node: KnowledgeNode,
): Promise<LinkEntitiesResult> {
  const result: LinkEntitiesResult = { linked: [], skipped: [], ambiguous: [] };
  // Secrets never take part; the linker reads prose only.
  if (node.kind === "credential") return result;

  const entities = await loadEntities(storage);
  if (entities.length === 0) return result;
  const scan = findEntityMentions(`${node.title}\n${node.content_md ?? ""}`, entities, {
    excludeId: node.id,
  });
  if (scan.matches.length === 0 && scan.ambiguous.length === 0) return result;

  // Read the dismissals fresh: the caller's copy of the node may predate an
  // unlink that landed while this sweep was queued behind the write.
  const dismissed = new Set(readDismissedEntityLinks((await storage.getNode(node.id))?.data ?? node.data));
  const existing = new Set(
    (await storage.listEdges())
      .filter((e) => e.from_node === node.id && e.relation === ENTITY_LINK_RELATION)
      .map((e) => e.to_node),
  );
  const byId = new Map(entities.map((e) => [e.id, e]));

  for (const match of scan.matches) {
    if (match.entityId === node.id) continue;
    if (existing.has(match.entityId) || dismissed.has(match.entityId)) {
      result.skipped.push(match.entityId);
      continue;
    }
    const entity = byId.get(match.entityId)!;
    const edge: NodeEdge = { from_node: node.id, to_node: entity.id, relation: ENTITY_LINK_RELATION };
    await storage.createEdge(edge);
    result.linked.push(entity.id);
    recordActivity(activityKey(storage), "update", node.id, node.title, `entity linked: ${entity.title}`, {
      actorKind: "system",
      payload: changePayload({
        before: node,
        after: node,
        via: "system",
        source: "nexo.entity_linker",
        relations: [{ operation: "link", from_id: node.id, to_id: entity.id, relation: ENTITY_LINK_RELATION }],
        extra: { entity_id: entity.id, matched_term: match.term },
      }),
    });
    if (storage.backend === "supabase") {
      const { wsBroadcast } = await import("@/lib/collab/server-broadcast");
      await wsBroadcast.graphChanged(
        storage.workspace.id,
        "edge",
        "created",
        `${edge.from_node}>${edge.to_node}:${edge.relation}`,
      );
    }
  }

  for (const amb of scan.ambiguous) {
    const candidates = amb.entityIds.filter((id) => id !== node.id && !dismissed.has(id) && !existing.has(id));
    if (candidates.length < 2) continue;
    result.ambiguous.push({ term: amb.term, entityIds: candidates });
    if (storage.backend === "supabase") {
      await openAmbiguityDoubt(storage, node, amb.term, candidates.map((id) => byId.get(id)!));
    }
  }
  return result;
}

/**
 * One open doubt per (node, term): a redelivered save must not stack rows.
 */
async function openAmbiguityDoubt(
  storage: Storage,
  node: Pick<KnowledgeNode, "id" | "title">,
  term: string,
  entities: EntityRef[],
): Promise<void> {
  const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
  const { openConflict } = await import("./conflicts");
  const summary = `"${term}" in "${node.title}" could mean ${entities.length} entities: ${entities
    .map((e) => e.title)
    .join(", ")}.`;
  const { data: dupes } = await getSupabaseAdmin()
    .from("nexo_conflicts")
    .select("id")
    .eq("workspace_id", storage.workspace.id)
    .eq("kind", "doubt")
    .eq("status", "open")
    .contains("related_node_ids", [node.id])
    .eq("summary", summary.slice(0, 400))
    .limit(1);
  if (dupes && dupes.length > 0) return;
  await openConflict({
    workspaceId: storage.workspace.id,
    kind: "doubt",
    summary,
    contextMd: [
      `## Mention\n"${term}" appears in /n/${node.id} and matches more than one entity, so NEXO did not link it.`,
      `## Candidates\n${entities.map((e) => `- /n/${e.id} — ${e.title}${e.aliases.length ? ` (aliases: ${e.aliases.join(", ")})` : ""}`).join("\n")}`,
      `## Resolution\nSay which entity is meant (or that none is) and NEXO will link it.`,
    ].join("\n\n"),
    evidence: [{ source: "graph", url: `/n/${node.id}`, excerpt: term }],
    relatedNodeIds: [node.id, ...entities.map((e) => e.id)],
  });
}

/**
 * A human removed a `references` edge onto an entity: remember it on the
 * source node so the next sweep does not put it straight back. No-op when
 * the target is not an entity. Best effort.
 */
export async function rememberDismissedEntityLink(
  storage: Storage,
  fromId: string,
  toId: string,
): Promise<boolean> {
  try {
    const [from, to] = await Promise.all([storage.getNode(fromId), storage.getNode(toId)]);
    if (!from || !to || to.kind !== "entity") return false;
    const dismissed = readDismissedEntityLinks(from.data);
    if (dismissed.includes(toId)) return true;
    const next = [...dismissed, toId];
    while (next.length > DISMISSED_MAX) next.shift();
    await storage.updateNode(fromId, { data: { ...(from.data ?? {}), entity_links_dismissed: next } });
    return true;
  } catch (err) {
    log.warn("nexo.entity_linker.dismiss_failed", {
      workspace_id: storage.workspace.id,
      from_id: fromId,
      to_id: toId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
