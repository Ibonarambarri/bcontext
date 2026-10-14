/**
 * Weekly digest — the first built-in scheduled skill (NEXO proactivity).
 *
 * The brain speaks without being asked: once a week, per workspace, it reads
 * the change feed and the task/decision state, and publishes a `doc` node
 * "Digest semanal <YYYY-MM-DD>" with four H2 blocks — what changed, what was
 * decided, what is blocked, what can start. The facts come from the graph;
 * the prose comes from the model when an AI gateway is configured and from
 * a plain structured renderer when it is not, so the digest exists in
 * tests, in the demo store and in a workspace that never set a key.
 *
 * Two layers, on purpose:
 *   - `collectDigestFacts` / `renderDigestMarkdown` are pure over a Storage
 *     and the change feed. Testable from the demo store.
 *   - `publishWeeklyDigest` is the side effects: node write, activity entry,
 *     realtime broadcast, optional webhook event (`digest.published`) and
 *     optional email to workspace admins. Every delivery is best-effort; the
 *     node is the only thing that must land.
 */
import { createGateway, generateObject } from "ai";
import { z } from "zod";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { chatModel } from "@/lib/ai/models";
import { log } from "@bcontext-dev/contract/log";
import { isTerminalStatus, type KnowledgeNode, type NodeSummary } from "@bcontext-dev/contract/types";
import type { ActivityEntry } from "@bcontext-dev/contract/activity";
import { listChangePageForStorage, record as recordActivity } from "@/lib/activity";
import type { Storage } from "@/lib/storage";
import { recordAiUsageEvent, tokensFromUsage } from "@/lib/telemetry/ai-usage";

export const DIGEST_SOURCE = "nexo.digest";
const DEFAULT_DIGEST_DAYS = 7;
/** Feed pages read per digest — 5 × 200 entries covers a very busy week. */
const MAX_FEED_PAGES = 5;
const TOP_NODES = 12;
const MAX_LIST = 15;

export interface DigestRef {
  id: string;
  title: string;
  kind: string;
}

export interface DigestFacts {
  workspace: { id: string; slug: string; name: string };
  from: string;
  to: string;
  changes: {
    total: number;
    by_action: Record<string, number>;
    by_actor: { human: number; agent: number; system: number };
    /** Most-touched nodes, with how many feed entries each collected. */
    top_nodes: Array<DigestRef & { events: number; last_action: string }>;
  };
  /** Tasks and bugs that reached `done` inside the window. */
  completed: DigestRef[];
  /** Decisions created inside the window, with the gist of their Decision block. */
  decided: Array<DigestRef & { gist: string | null }>;
  /** Open tasks with an open `blocked_by` edge, or explicitly `blocked`. */
  blocked: Array<DigestRef & { status: string | null; blockers: Array<DigestRef & { status: string | null }> }>;
  /** Open tasks with nothing in the way, best priority first. */
  startable: Array<DigestRef & { priority: string | null; status: string | null }>;
}

export interface DigestDelivery {
  webhook?: boolean;
  email?: boolean;
}

export interface PublishDigestOptions {
  now?: Date;
  days?: number;
  delivery?: DigestDelivery;
  /** Overrides `AI_GATEWAY_API_KEY`; an empty string forces the plain renderer. */
  apiKey?: string;
  model?: string;
  /** Who is recorded as the actor of the run; the scheduler passes `system`. */
  actorKind?: "human" | "agent" | "system";
  actorId?: string | null;
}

export interface PublishDigestResult {
  node: KnowledgeNode;
  /** false when a digest with the same title already existed and was refreshed. */
  created: boolean;
  facts: DigestFacts;
  /** The model that wrote the prose, or null for the plain renderer. */
  model_used: string | null;
  delivered: { webhook: boolean; email: number };
}

// -- Facts -------------------------------------------------------------------

const TASK_KINDS = new Set(["task", "bug"]);
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, med: 2, low: 3 };

function ref(node: Pick<NodeSummary, "id" | "title" | "kind">): DigestRef {
  return { id: node.id, title: node.title, kind: node.kind };
}

async function readWindow(storage: Storage, from: string, to: string): Promise<ActivityEntry[]> {
  const entries: ActivityEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
    const result = await listChangePageForStorage(storage, storage.workspace.slug, {
      from,
      to,
      limit: 200,
      cursor,
    });
    entries.push(...result.entries);
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  // The digest's own publications are not "what changed this week".
  return entries.filter((entry) => entry.source !== DIGEST_SOURCE);
}

/** First sentence-ish of a decision's `## Decision` block (or its body). */
export function decisionGist(content: string | null | undefined): string | null {
  if (!content) return null;
  const block = content.match(/^##\s+Decisi[oó]n\s*\n([\s\S]*?)(?=^##\s|\s*$)/im)?.[1] ?? content;
  const text = block
    .replace(/^#+\s.*$/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text;
}

/** The pure layer: everything the digest says, read from the graph over the last `days`. */
export async function collectDigestFacts(
  storage: Storage,
  opts: { now?: Date; days?: number } = {},
): Promise<DigestFacts> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? DEFAULT_DIGEST_DAYS;
  const to = now.toISOString();
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();

  const [entries, summaries, edges] = await Promise.all([
    readWindow(storage, from, to),
    storage.listNodeSummaries({ limit: 5000 }),
    storage.listEdges(),
  ]);
  const byId = new Map(summaries.map((n) => [n.id, n]));

  // What changed: counts and the nodes that collected the most entries.
  const byAction: Record<string, number> = {};
  const byActor = { human: 0, agent: 0, system: 0 };
  const perNode = new Map<string, { ref: DigestRef; events: number; last_action: string }>();
  for (const entry of entries) {
    byAction[entry.kind] = (byAction[entry.kind] ?? 0) + 1;
    if (entry.actor_kind) byActor[entry.actor_kind] += 1;
    if (!entry.node_id) continue;
    const current = perNode.get(entry.node_id);
    if (current) {
      current.events += 1;
      continue;
    }
    const live = byId.get(entry.node_id);
    perNode.set(entry.node_id, {
      ref: live ? ref(live) : { id: entry.node_id, title: entry.node_title ?? entry.node_id, kind: entry.node_kind ?? "doc" },
      events: 1,
      // Entries arrive newest first, so the first one seen is the latest.
      last_action: entry.kind,
    });
  }
  const topNodes = [...perNode.values()]
    .sort((a, b) => b.events - a.events || a.ref.title.localeCompare(b.ref.title))
    .slice(0, TOP_NODES)
    .map((n) => ({ ...n.ref, events: n.events, last_action: n.last_action }));

  const inWindow = (ts: string) => ts >= from && ts <= to;

  const completed = summaries
    .filter((n) => TASK_KINDS.has(n.kind) && n.status === "done" && inWindow(n.updated_at))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, MAX_LIST)
    .map(ref);

  // Decisions: created this week per the summaries, plus any the feed saw
  // created (a decision deleted since is still "what was decided").
  const decisionIds = new Set<string>();
  for (const n of summaries) if (n.kind === "decision" && inWindow(n.created_at)) decisionIds.add(n.id);
  for (const e of entries) if (e.kind === "create" && e.node_kind === "decision" && e.node_id) decisionIds.add(e.node_id);
  const decided: DigestFacts["decided"] = [];
  for (const id of [...decisionIds].slice(0, MAX_LIST)) {
    const live = byId.get(id);
    const full = live ? await storage.getNode(id).catch(() => null) : null;
    const fromFeed = entries.find((e) => e.node_id === id);
    decided.push({
      id,
      title: live?.title ?? fromFeed?.node_title ?? id,
      kind: "decision",
      gist: decisionGist(full?.content_md),
    });
  }
  decided.sort((a, b) => (byId.get(b.id)?.created_at ?? "").localeCompare(byId.get(a.id)?.created_at ?? ""));

  // Blocked and startable, from the dependency edges.
  const openBlockers = new Map<string, Array<DigestRef & { status: string | null }>>();
  for (const edge of edges) {
    if (edge.relation !== "blocked_by") continue;
    const blocker = byId.get(edge.to_node);
    if (!blocker || isTerminalStatus(blocker.status)) continue;
    const list = openBlockers.get(edge.from_node) ?? [];
    list.push({ ...ref(blocker), status: blocker.status });
    openBlockers.set(edge.from_node, list);
  }
  const openTasks = summaries.filter((n) => TASK_KINDS.has(n.kind) && !isTerminalStatus(n.status));
  const blocked: DigestFacts["blocked"] = openTasks
    .filter((n) => n.status === "blocked" || openBlockers.has(n.id))
    .map((n) => ({ ...ref(n), status: n.status, blockers: openBlockers.get(n.id) ?? [] }))
    .sort((a, b) => b.blockers.length - a.blockers.length || a.title.localeCompare(b.title))
    .slice(0, MAX_LIST);
  const startable: DigestFacts["startable"] = openTasks
    .filter((n) => (n.status === "todo" || n.status === "backlog") && !openBlockers.has(n.id))
    .sort(
      (a, b) =>
        (PRIORITY_RANK[a.priority ?? ""] ?? 9) - (PRIORITY_RANK[b.priority ?? ""] ?? 9) ||
        (a.status === "todo" ? 0 : 1) - (b.status === "todo" ? 0 : 1) ||
        b.updated_at.localeCompare(a.updated_at),
    )
    .slice(0, MAX_LIST)
    .map((n) => ({ ...ref(n), priority: n.priority, status: n.status }));

  return {
    workspace: { id: storage.workspace.id, slug: storage.workspace.slug, name: storage.workspace.name },
    from,
    to,
    changes: { total: entries.length, by_action: byAction, by_actor: byActor, top_nodes: topNodes },
    completed,
    decided,
    blocked,
    startable,
  };
}

// -- Rendering ---------------------------------------------------------------

const DIGEST_SECTIONS = ["Qué cambió", "Qué se decidió", "Qué está bloqueado", "Qué se puede empezar"] as const;

const ACTION_LABEL: Record<string, string> = {
  create: "creados",
  update: "actualizados",
  delete: "borrados",
  rename: "renombrados",
  move: "movidos",
  agent: "de agentes",
  workspace: "del workspace",
};
const STATUS_LABEL: Record<string, string> = {
  backlog: "backlog",
  todo: "por hacer",
  in_progress: "en curso",
  review: "en revisión",
  blocked: "bloqueada",
  done: "hecha",
  archived: "archivada",
};

const link = (r: DigestRef) => `[${r.title.replace(/[[\]]/g, " ")}](/n/${r.id})`;
const day = (iso: string) => iso.slice(0, 10);

export interface DigestProse {
  changed: string;
  decided: string;
  blocked: string;
  startable: string;
}

/** The four blocks as bullet lists; prose, when present, opens each block. */
export function renderDigestMarkdown(facts: DigestFacts, prose?: Partial<DigestProse> | null): string {
  const c = facts.changes;
  const changedLines: string[] = [];
  if (c.total === 0) {
    changedLines.push("- Sin cambios registrados esta semana.");
  } else {
    const parts = Object.entries(c.by_action)
      .sort((a, b) => b[1] - a[1])
      .map(([action, n]) => `${n} ${ACTION_LABEL[action] ?? action}`)
      .join(", ");
    const actors = [
      c.by_actor.human ? `${c.by_actor.human} de personas` : null,
      c.by_actor.agent ? `${c.by_actor.agent} de agentes` : null,
      c.by_actor.system ? `${c.by_actor.system} del sistema` : null,
    ].filter(Boolean).join(", ");
    changedLines.push(`- **${c.total} cambios** (${parts})${actors ? ` — ${actors}` : ""}.`);
    if (c.top_nodes.length) {
      changedLines.push(`- Nodos más activos: ${c.top_nodes.slice(0, 6).map((n) => `${link(n)} (${n.events})`).join(", ")}.`);
    }
  }
  if (facts.completed.length) {
    changedLines.push(`- Terminado: ${facts.completed.map(link).join(", ")}.`);
  }

  const decidedLines = facts.decided.length
    ? facts.decided.map((d) => `- ${link(d)}${d.gist ? ` — ${d.gist}` : ""}`)
    : ["- Ninguna decisión nueva esta semana."];

  const blockedLines = facts.blocked.length
    ? facts.blocked.map((b) => {
        const by = b.blockers.length
          ? ` — bloqueada por ${b.blockers.map((x) => `${link(x)}${x.status ? ` (${STATUS_LABEL[x.status] ?? x.status})` : ""}`).join(", ")}`
          : " — marcada como bloqueada, sin bloqueador enlazado";
        return `- ${link(b)}${by}`;
      })
    : ["- Nada bloqueado."];

  const startableLines = facts.startable.length
    ? facts.startable.map((s) => `- ${link(s)}${s.priority ? ` (${s.priority})` : ""}`)
    : ["- No hay tareas libres en `todo` o `backlog`."];

  const section = (title: string, text: string | undefined, lines: string[]) =>
    [`## ${title}`, "", ...(text?.trim() ? [text.trim(), ""] : []), ...lines, ""].join("\n");

  return [
    `_Semana del ${day(facts.from)} al ${day(facts.to)} en **${facts.workspace.name}** · ${c.total} cambios · generado por NEXO._`,
    "",
    section(DIGEST_SECTIONS[0], prose?.changed, changedLines),
    section(DIGEST_SECTIONS[1], prose?.decided, decidedLines),
    section(DIGEST_SECTIONS[2], prose?.blocked, blockedLines),
    section(DIGEST_SECTIONS[3], prose?.startable, startableLines),
  ].join("\n").trimEnd() + "\n";
}

/** Also the idempotency key: one digest per workspace per day, refreshed on re-run. */
export function digestTitle(now: Date): string {
  return `Digest semanal ${now.toISOString().slice(0, 10)}`;
}

// -- Prose (AI gateway, optional) --------------------------------------------

const ProseSchema = z.object({
  changed: z.string().max(900),
  decided: z.string().max(900),
  blocked: z.string().max(900),
  startable: z.string().max(900),
});

const PROSE_SYSTEM = [
  "You write the weekly digest of a company's knowledge workspace for the people who run it.",
  "You receive structured facts; you never invent facts, names, numbers or node ids.",
  "For each of the four sections write one short paragraph (1–3 sentences, plain text, no headings, no bullet lists, no links):",
  "changed — what moved this week and where the energy went; decided — what was settled and what it implies;",
  "blocked — what is stuck and on what; startable — what is free to pick up next, by priority.",
  "Write in the language the node titles are written in (default Spanish). Be concrete and calm; an empty section gets one honest sentence.",
].join(" ");

async function writeDigestProse(
  facts: DigestFacts,
  opts: { apiKey?: string; model?: string },
): Promise<{ prose: DigestProse; model: string } | null> {
  const model = chatModel(opts.model);
  try {
    const result = await generateObject({
      model: opts.apiKey ? createGateway({ apiKey: opts.apiKey })(model) : languageModel(model),
      system: PROSE_SYSTEM,
      prompt: `## Facts (JSON)\n${JSON.stringify(facts, null, 1).slice(0, 24_000)}`,
      schema: ProseSchema,
    });
    void recordAiUsageEvent({
      workspaceId: facts.workspace.id,
      surface: "skill_run",
      model,
      tokens: tokensFromUsage(result.usage),
      metadata: { kind: "digest_weekly", changes: facts.changes.total },
    });
    return { prose: result.object, model };
  } catch (err) {
    log.warn("digest.prose_failed", {
      workspace_id: facts.workspace.id,
      model,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

// -- Publish -----------------------------------------------------------------

async function aiTagId(storage: Storage): Promise<string | null> {
  try {
    const tags = await storage.listTags();
    const hit = tags.find((t) => t.slug === "ai" || t.name.trim().toLowerCase() === "ai");
    return hit?.id ?? null;
  } catch {
    return null;
  }
}

/** The side-effect layer: writes (or refreshes) the digest node, then delivers best-effort. */
export async function publishWeeklyDigest(
  storage: Storage,
  opts: PublishDigestOptions = {},
): Promise<PublishDigestResult> {
  const now = opts.now ?? new Date();
  const facts = await collectDigestFacts(storage, { now, days: opts.days });

  // An explicit key (even an empty one) decides; otherwise the instance's backend.
  const useModel = opts.apiKey !== undefined ? Boolean(opts.apiKey) : aiConfigured();
  const written = useModel ? await writeDigestProse(facts, { apiKey: opts.apiKey || undefined, model: opts.model }) : null;
  const content_md = renderDigestMarkdown(facts, written?.prose ?? null);
  const title = digestTitle(now);
  const data = {
    source: DIGEST_SOURCE,
    digest: {
      kind: "digest_weekly",
      from: facts.from,
      to: facts.to,
      changes: facts.changes.total,
      decided: facts.decided.length,
      blocked: facts.blocked.length,
      startable: facts.startable.length,
      model: written?.model ?? null,
    },
  };

  // Same day, same workspace → refresh the existing digest rather than stack
  // a second one; a retried job or a manual "run now" after the scheduled
  // run both land here.
  const existing = (await storage.listNodeSummaries({ limit: 5000 })).find(
    (n) => n.kind === "doc" && n.title === title && n.source === DIGEST_SOURCE,
  );
  let node: KnowledgeNode;
  let created: boolean;
  if (existing) {
    const updated = await storage.updateNode(existing.id, { content_md, data });
    node = updated ?? (await storage.getNode(existing.id)) ?? (existing as unknown as KnowledgeNode);
    created = false;
  } else {
    const tagId = await aiTagId(storage);
    node = await storage.createNode({
      title,
      kind: "doc",
      parent_id: null,
      content_md,
      data,
      ...(tagId ? { tag_ids: [tagId] } : {}),
    });
    created = true;
  }

  const actorKind = opts.actorKind ?? "system";
  recordActivity(storage.workspace.slug, created ? "create" : "update", node.id, node.title, "weekly digest published", {
    actorKind,
    actorId: opts.actorId ?? null,
    payload: { via: "worker", node_kind: "doc", source: DIGEST_SOURCE, digest_from: facts.from, digest_to: facts.to },
  });

  const delivered = { webhook: false, email: 0 };
  if (storage.backend === "supabase") {
    const { wsBroadcast } = await import("@/lib/collab/server-broadcast");
    if (created) void wsBroadcast.nodeCreated(storage.workspace.id, node.id);
    else void wsBroadcast.nodeUpdated(storage.workspace.id, node.id);

    if (opts.delivery?.webhook) {
      try {
        const [{ emitEvent }, { getSupabaseAdmin }] = await Promise.all([
          import("@/lib/webhooks/dispatch"),
          import("@/lib/supabase/admin"),
        ]);
        const result = await emitEvent(getSupabaseAdmin(), {
          workspaceId: storage.workspace.id,
          workspaceSlug: storage.workspace.slug,
          type: "digest.published",
          data: { id: node.id, title: node.title, from: facts.from, to: facts.to, changes: facts.changes.total, url: `/n/${node.id}` },
        });
        delivered.webhook = result.matched > 0;
      } catch (err) {
        log.warn("digest.webhook_failed", { workspace_id: storage.workspace.id, error: { message: err instanceof Error ? err.message : String(err) } });
      }
    }
    if (opts.delivery?.email) {
      try {
        const [{ sendDigestEmail }, { listWorkspaceAdminEmails }] = await Promise.all([
          import("./digest-email"),
          import("./schedules"),
        ]);
        const to = await listWorkspaceAdminEmails(storage.workspace.id);
        if (to.length) {
          const sent = await sendDigestEmail({ to, workspaceName: storage.workspace.name, workspaceSlug: storage.workspace.slug, organizationId: storage.workspace.organization_id, nodeId: node.id, title: node.title, markdown: content_md });
          delivered.email = sent.status === "sent" ? to.length : 0;
        }
      } catch (err) {
        log.warn("digest.email_failed", { workspace_id: storage.workspace.id, error: { message: err instanceof Error ? err.message : String(err) } });
      }
    }
  }

  log.info("digest.published", {
    workspace_id: storage.workspace.id,
    node_id: node.id,
    created,
    changes: facts.changes.total,
    model: written?.model ?? null,
    ...delivered,
  });
  return { node, created, facts, model_used: written?.model ?? null, delivered };
}
