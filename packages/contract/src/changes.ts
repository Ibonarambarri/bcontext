/**
 * The workspace change feed (`list_changes` tool, `GET /api/activity`, the
 * "Changes" view): snapshot shape recorded per node write, provenance (who —
 * user, agent token, connector — and through which surface), the realtime
 * event names that invalidate it, cursor encoding, and the redaction that
 * keeps credential values and private reasoning out of the feed.
 *
 * Retention is `CHANGE_RETENTION_DAYS`; the feed is an audit trail, not an
 * undo log — nothing here implies rollback.
 */
import { redactCredentialData } from "./credentials.js";
import type { KnowledgeNode, NodeKind } from "./types.js";

export const CHANGE_RETENTION_DAYS = 180;
export const CHANGES_REALTIME_EVENTS = [
  "node.created",
  "node.updated",
  "node.renamed",
  "node.moved",
  "node.deleted",
  "backlink.changed",
] as const;

export interface ChangeSnapshot {
  title: string;
  slug: string;
  kind: NodeKind;
  parent_id: string | null;
  content_md: string;
  data: Record<string, unknown>;
  status: KnowledgeNode["status"];
  priority: KnowledgeNode["priority"];
  due_date: string | null;
  tags: Array<{ id: string; name: string; slug: string }>;
  updated_at: string;
}

export interface ChangeRelation {
  operation: "link" | "unlink" | "affected";
  from_id: string;
  to_id: string;
  relation: string;
}

export interface ChangeProvenance {
  via: string | null;
  sources: string[];
  references: string[];
}

export interface ChangeReview {
  status: "pending" | "accepted" | "rejected";
  label: string;
  review_url: string | null;
}

const SENSITIVE_KEY = /(?:^|_)(?:authorization|cookie|token|secret|password|passphrase|api[_-]?key|credential|private[_-]?key|access[_-]?key)(?:$|_)/i;
const PRIVATE_REASONING_KEY = /(?:^|_)(?:reasoning|chain[_-]?of[_-]?thought|thoughts|analysis|scratchpad)(?:$|_)/i;
const MAX_STRING = 40_000;

/**
 * Redact at the write boundary. Changes never persist credentials or private
 * model reasoning, even if a caller accidentally puts them in node metadata.
 */
export function redactChangeValue(value: unknown, key = ""): unknown {
  if (PRIVATE_REASONING_KEY.test(key)) return "[OMITTED: private model reasoning]";
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}\n… [truncated]`
      : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => redactChangeValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactChangeValue(childValue, childKey);
    }
    return out;
  }
  return String(value ?? "");
}

export function nodeChangeSnapshot(node: KnowledgeNode): ChangeSnapshot {
  return {
    title: node.title,
    slug: node.slug,
    kind: node.kind,
    parent_id: node.parent_id,
    content_md: String(redactChangeValue(node.content_md)),
    // A credential's values live under `data.fields[].value`, a key the
    // sensitive-key heuristic below has no way to recognise — so the shape
    // is redacted by kind, not by name, before it is ever persisted.
    data:
      node.kind === "credential"
        ? redactCredentialData(node.data, node.id)
        : (redactChangeValue(node.data) as Record<string, unknown>),
    status: node.status,
    priority: node.priority,
    due_date: node.due_date,
    tags: node.tags.map(({ id, name, slug }) => ({ id, name, slug })),
    updated_at: node.updated_at,
  };
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 100);
}

export function provenanceForNode(
  node: KnowledgeNode | null,
  via: string | null,
  supplied?: { sources?: unknown; references?: unknown },
): ChangeProvenance {
  const data = node?.data ?? {};
  return {
    via,
    sources: [...new Set([
      ...stringList(supplied?.sources),
      ...stringList(data.sources),
      ...stringList(data.source),
      ...stringList(data.source_url),
      ...stringList(data.url),
      ...stringList(data.imported_from),
    ])].slice(0, 100),
    references: [...new Set([
      ...stringList(supplied?.references),
      ...stringList(data.references),
      ...stringList(data.citations),
    ])].slice(0, 100),
  };
}

export function changePayload(args: {
  before?: KnowledgeNode | null;
  after?: KnowledgeNode | null;
  via: string;
  source?: string | null;
  blockId?: string | null;
  relations?: ChangeRelation[];
  references?: unknown;
  sources?: unknown;
  review?: ChangeReview | null;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const node = args.after ?? args.before ?? null;
  const relations = [...(args.relations ?? [])];
  const nodeId = args.after?.id ?? args.before?.id;
  if (nodeId && args.before?.parent_id !== args.after?.parent_id) {
    if (args.before?.parent_id) relations.push({ operation: "unlink", from_id: nodeId, to_id: args.before.parent_id, relation: "parent" });
    if (args.after?.parent_id) relations.push({ operation: "link", from_id: nodeId, to_id: args.after.parent_id, relation: "parent" });
  }
  const provenance = provenanceForNode(node, args.via, {
    sources: args.sources,
    references: args.references,
  });
  return redactChangeValue({
    ...(args.extra ?? {}),
    node_kind: node?.kind ?? null,
    tag_ids: node?.tags.map((tag) => tag.id) ?? [],
    tag_slugs: node?.tags.map((tag) => tag.slug) ?? [],
    source: args.source ?? provenance.sources[0] ?? args.via,
    block_id: args.blockId ?? null,
    before: args.before ? nodeChangeSnapshot(args.before) : null,
    after: args.after ? nodeChangeSnapshot(args.after) : null,
    snapshot_state: args.before || args.after ? "available" : "not_recorded",
    affected_relations: relations,
    provenance,
    review: args.review ?? null,
    // Generic rollback is intentionally unavailable. A future writer may add
    // an explicit, audited compensation contract rather than flipping this.
    revert: {
      available: false,
      reason: "No audited compensation contract was supplied for this change.",
    },
  }) as Record<string, unknown>;
}

export interface ChangeCursorValue {
  ts: string;
  id: string;
}

export function encodeChangeCursor(value: ChangeCursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeChangeCursor(cursor: string): ChangeCursorValue | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof value.ts !== "string" || !Number.isFinite(Date.parse(value.ts)) || typeof value.id !== "string" || !value.id) return null;
    return { ts: value.ts, id: value.id };
  } catch {
    return null;
  }
}
