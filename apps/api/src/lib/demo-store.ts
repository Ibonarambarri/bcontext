/**
 * In-memory demo store. Used when Supabase env is not configured so the API
 * (and the whole test suite) works without a database. The shape mirrors the
 * SQL `nodes` table; `src/lib/storage` picks this or Supabase per workspace.
 *
 * Multi-workspace: every store call is scoped by workspace slug. Workspaces
 * are themselves first-class objects so the sidebar switcher can list and
 * create them.
 */
import type { KnowledgeNode, Workspace, WorkspaceTag } from "@bcontext-dev/contract/types";
import { isSupabaseConfigured as envIsSupabaseConfigured } from "@bcontext-dev/contract/env";
import { nextPreviousBlockIds } from "@bcontext-dev/contract/rag/chunk";

export function isSupabaseConfigured(): boolean {
  return envIsSupabaseConfigured();
}

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const DEMO_SEED_TIME = "2026-01-01T00:00:00.000Z";

/** Canonical first-class tag used by the in-memory seed and taxonomy store. */
export function demoSeedTag(workspaceId: string, normalized: string): WorkspaceTag {
  return {
    id: `demo-tag-${workspaceId}-${normalized}`,
    workspace_id: workspaceId,
    name: normalized === "ai" ? "AI" : normalized[0]!.toUpperCase() + normalized.slice(1),
    normalized_name: normalized,
    slug: normalized,
    description: null,
    merged_into_id: null,
    deleted_at: null,
    created_at: DEMO_SEED_TIME,
    updated_at: DEMO_SEED_TIME,
  };
}

function makeWorkspace(
  id: string,
  slug: string,
  name: string,
  description: string,
  metadata: Record<string, unknown> = {},
): Workspace {
  return {
    id,
    organization_id: ORG_ID,
    slug,
    name,
    description,
    github_repo: null,
    metadata,
    created_at: new Date().toISOString(),
  };
}

function n(
  workspace_id: string,
  id: string,
  parent: string | null,
  kind: KnowledgeNode["kind"],
  slug: string,
  title: string,
  content_md: string,
  extras: Partial<KnowledgeNode> = {},
): KnowledgeNode {
  const now = new Date().toISOString();
  return {
    id,
    workspace_id,
    parent_id: parent,
    kind,
    slug,
    title,
    content_md,
    data: {},
    tags: [],
    status: null,
    priority: null,
    assignee_id: null,
    due_date: null,
    position: 0,
    created_by: null,
    created_at: now,
    updated_at: now,
    ...extras,
  };
}

// --- Seed workspaces -------------------------------------------------------

const WS_CONTEXT = "00000000-0000-0000-0000-000000000010";
const WS_DEMO = "00000000-0000-0000-0000-000000000020";

// Demo workspaces carry explicit accent gradients so demo mode exercises the
// per-workspace accent theme (buttons/focus re-tint per workspace) exactly
// like a real workspace created through the modal (PR #109 persists this).
const workspacesSeed: Workspace[] = [
  makeWorkspace(
    WS_CONTEXT,
    "bcontext",
    "Context OS",
    "Reference workspace demonstrating the canonical Bcontext structure.",
    { accent_gradient: "forest" },
  ),
  makeWorkspace(
    WS_DEMO,
    "demo-startup",
    "Demo Startup",
    "Empty starter so you can see how a fresh project looks.",
    { accent_gradient: "ember" },
  ),
];

const contextNodes: KnowledgeNode[] = [
  n(
    WS_CONTEXT,
    "d-vision",
    null,
    "doc",
    "vision",
    "Vision",
    `---
title: Vision
owner: founder
status: draft
---

# Vision

Bcontext is an **AI-native operating system for project context**. It is the
single place where humans and agents can read, write, and reason about every
piece of operational knowledge a startup produces.

## Why now

LLMs are bottlenecked by context, not capability. Teams ship faster when their
docs, decisions, tasks, and bugs are structured, vectorized, and reachable
through a single retrieval surface — instead of scattered across Notion, Linear,
Slack, and a dozen Google Docs.

## Principles

- **Local-first**: every document round-trips to Markdown and JSON. No lock-in.
- **AI-first citizens**: agents are first-class actors with the same API surface.
- **Silent UX**: minimalist, keyboard-driven, fast.
`,
    { tags: [demoSeedTag(WS_CONTEXT, "business")] },
  ),
  n(
    WS_CONTEXT,
    "d-architecture",
    null,
    "doc",
    "architecture",
    "Architecture",
    `# Architecture

\`\`\`
Next.js (App Router) ── /app
  ├── /(workspace)/[ws] — three-zone layout
  ├── /api/nexo         — Nexo, the in-app assistant (streaming, tool-using)
  ├── /api/nodes        — CRUD over knowledge graph
  └── /api/agents/*     — structured agent surface

Supabase
  ├── auth.users
  ├── nodes (doc|task|decision|meeting|bug|adr|entity|skill)
  ├── edges (typed relations)
  ├── embeddings (pgvector, 1536)
  └── activity (append-only log)

Sync
  └── GitHub repo (markdown + json export, versioned mirror)
\`\`\`

The graph is the product. Everything else is a view.
`,
    { tags: [demoSeedTag(WS_CONTEXT, "tech")] },
  ),
  n(
    WS_CONTEXT,
    "t-onboard",
    null,
    "task",
    "wire-supabase",
    "Wire Supabase credentials",
    "## Acceptance\n\n- Paste NEXT_PUBLIC_SUPABASE_URL into .env.local\n- Paste anon + service keys\n- Run the SQL in /supabase/migrations/0001_init.sql\n- Reload the app — sidebar should populate from the DB.",
    { status: "todo", priority: "high" },
  ),
  n(
    WS_CONTEXT,
    "t-embed",
    null,
    "task",
    "build-embedding-pipeline",
    "Build embedding pipeline",
    "Re-embed nodes on update from the storage write path.",
    { status: "in_progress", priority: "med" },
  ),
  n(
    WS_CONTEXT,
    "dec-stack",
    null,
    "decision",
    "use-tiptap-for-editor",
    "ADR-001: Use TipTap for the editor",
    "## Decision\n\nUse TipTap. ProseMirror-based, extensible, plays well with collab (Yjs) later.\n\n## Alternatives\n\n- Lexical: less mature collab story\n- Plate: heavier surface area\n- Custom contenteditable: too costly",
  ),
  n(
    WS_CONTEXT,
    "b-vector",
    null,
    "bug",
    "ivfflat-cold-start",
    "ivfflat cold-start returns no rows",
    "Right after the migration, `match_nodes` returns zero rows until ANALYZE runs. Need a post-migration ANALYZE step or switch to HNSW.",
  ),
  n(
    WS_CONTEXT,
    "data-signups",
    null,
    "data",
    "beta-signups",
    "Beta signups (CSV)",
    "Weekly beta signup funnel. Stored as CSV in a fenced block.\n\n```csv\nweek,signups,activated,churned\n2026-W01,42,18,3\n2026-W02,61,27,5\n2026-W03,55,31,4\n2026-W04,78,44,6\n```\n",
  ),
  n(
    WS_CONTEXT,
    "cred-supabase",
    null,
    "credential",
    "supabase-keys",
    "Supabase — project keys",
    "Keys for the Bcontext Supabase project. Values live in node.data.fields, masked by default.",
    {
      data: {
        fields: [
          { name: "Project ref", value: "demo-project-ref", secret: false },
          { name: "Anon key", value: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.demo.anon", secret: true },
          { name: "Service role key", value: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.demo.service", secret: true },
        ],
      },
    },
  ),
];

const demoNodes: KnowledgeNode[] = [
  n(
    WS_DEMO,
    "ds-prd",
    null,
    "doc",
    "starter-prd",
    "Starter PRD",
    "# Starter PRD\n\nReplace this with your first product brief.\n\n- **Problem**\n- **Users**\n- **Solution**\n- **Out of scope**",
    { tags: [demoSeedTag(WS_DEMO, "product")] },
  ),
];

// Stores live on globalThis so they survive module re-evaluation: a dev
// reload or a second bundle importing this module would otherwise get its
// own empty Map, and a create through one path would be invisible to a read
// through another. Anchoring on `globalThis` keeps demo storage process-wide.
interface DemoStoreGlobal {
  __bcontext_demo_workspaces?: Map<string, Workspace>;
  __bcontext_demo_nodes?: Map<string, Map<string, KnowledgeNode>>;
}
const g = globalThis as unknown as DemoStoreGlobal;

const workspaceStore: Map<string, Workspace> =
  g.__bcontext_demo_workspaces ??
  (g.__bcontext_demo_workspaces = new Map<string, Workspace>(
    workspacesSeed.map((w) => [w.slug, w]),
  ));

// Per-workspace node maps, keyed by workspace slug.
const nodeStores: Map<string, Map<string, KnowledgeNode>> =
  g.__bcontext_demo_nodes ??
  (g.__bcontext_demo_nodes = new Map<string, Map<string, KnowledgeNode>>());

function nodesForWorkspace(slug: string): Map<string, KnowledgeNode> {
  let m = nodeStores.get(slug);
  if (!m) {
    m = new Map();
    nodeStores.set(slug, m);
  }
  return m;
}

function positionSeed(nodes: KnowledgeNode[]) {
  const byParent = new Map<string | null, number>();
  for (const node of nodes) {
    const i = (byParent.get(node.parent_id) ?? 0) + 1;
    byParent.set(node.parent_id, i);
    if (!node.position) node.position = i;
  }
}

// Seed each workspace exactly once per process. Subsequent module evaluations
// (turbopack module re-bundling after a hot reload) must not clobber edits
// the user has made via the API.
function seedWorkspaceOnce(slug: string, seeds: KnowledgeNode[]): void {
  const map = nodesForWorkspace(slug);
  if (map.size > 0) return;
  positionSeed(seeds);
  seeds.forEach((node) => map.set(node.id, node));
}
seedWorkspaceOnce("bcontext", contextNodes);
seedWorkspaceOnce("demo-startup", demoNodes);

// --- Workspace API ---------------------------------------------------------

export function listWorkspaces(): Workspace[] {
  return Array.from(workspaceStore.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function getWorkspace(slug: string): Workspace | null {
  return workspaceStore.get(slug) ?? null;
}

export function createWorkspace(input: {
  name: string;
  slug?: string;
  description?: string;
}): Workspace {
  const slug =
    (input.slug ?? input.name)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || `ws-${Math.random().toString(36).slice(2, 8)}`;
  if (workspaceStore.has(slug)) {
    throw new Error(`Workspace "${slug}" already exists`);
  }
  const id = crypto.randomUUID();
  const ws: Workspace = {
    id,
    organization_id: ORG_ID,
    slug,
    name: input.name,
    description: input.description ?? null,
    github_repo: null,
    metadata: {},
    created_at: new Date().toISOString(),
  };
  workspaceStore.set(slug, ws);
  // New workspaces start empty; tags are the reusable classification layer.
  nodesForWorkspace(slug);
  return ws;
}

// --- Node API --------------------------------------------------------------

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Pick a unique slug within a workspace. The optional `ignoreId` lets the
 * caller exclude the node being updated so renaming back to the same title
 * doesn't collide with itself. Falls back to `fallbackId` (or a random suffix
 * when none is provided) if the base is empty or all candidate suffixes are
 * taken.
 */
function uniqueSlugInWorkspace(
  map: Map<string, KnowledgeNode>,
  base: string,
  fallbackId: string,
  ignoreId?: string,
): string {
  const existing = new Set<string>();
  for (const v of map.values()) {
    if (ignoreId && v.id === ignoreId) continue;
    existing.add(v.slug);
  }
  if (!base) return fallbackId;
  if (!existing.has(base)) return base;
  let suffixed = base;
  for (let i = 2; i <= 99; i++) {
    suffixed = `${base}-${i}`;
    if (!existing.has(suffixed)) return suffixed;
  }
  return fallbackId;
}

export function listNodes(workspaceSlug: string): KnowledgeNode[] {
  const map = nodesForWorkspace(workspaceSlug);
  return Array.from(map.values()).sort((a, b) => a.position - b.position);
}

export function getNode(
  workspaceSlug: string,
  id: string,
): KnowledgeNode | null {
  return nodesForWorkspace(workspaceSlug).get(id) ?? null;
}

export function updateNode(
  workspaceSlug: string,
  id: string,
  patch: Partial<KnowledgeNode>,
): KnowledgeNode | null {
  const map = nodesForWorkspace(workspaceSlug);
  const current = map.get(id);
  if (!current) return null;

  // Regenerate slug when the title changes and the caller didn't pass an
  // explicit slug. Node ids stay stable so existing tabs and routes
  // (/w/<ws>/n/<id>) continue to resolve — this is an internal-only rename.
  let nextSlug = current.slug;
  if (
    typeof patch.title === "string" &&
    patch.title.trim() !== current.title &&
    patch.slug === undefined
  ) {
    const base = slugify(patch.title);
    const computed = uniqueSlugInWorkspace(map, base, current.id, current.id);
    if (computed !== current.slug) {
      nextSlug = computed;
    }
  } else if (typeof patch.slug === "string") {
    nextSlug = patch.slug;
  }

  // Track the previous slug so a future redirect handler can resolve old URLs.
  let nextData = patch.data ?? current.data;
  const existingData =
    nextData && typeof nextData === "object" && !Array.isArray(nextData)
      ? (nextData as Record<string, unknown>)
      : {};
  if (nextSlug !== current.slug) {
    const prevList = Array.isArray(existingData.previous_slugs)
      ? (existingData.previous_slugs as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];
    if (!prevList.includes(current.slug)) prevList.push(current.slug);
    nextData = { ...existingData, previous_slugs: prevList };
  }

  // Track renamed/removed block_ids so inbound `/n/<id>#<block-id>`
  // references can still resolve via `data.previous_block_ids[]`.
  if (typeof patch.content_md === "string" && patch.content_md !== current.content_md) {
    const baseData =
      nextData && typeof nextData === "object" && !Array.isArray(nextData)
        ? (nextData as Record<string, unknown>)
        : existingData;
    const nextPrev = nextPreviousBlockIds(
      current.content_md,
      patch.content_md,
      baseData.previous_block_ids,
    );
    if (nextPrev) {
      nextData = { ...baseData, previous_block_ids: nextPrev };
    }
  }

  const next: KnowledgeNode = {
    ...current,
    ...patch,
    slug: nextSlug,
    data: nextData,
    updated_at: new Date().toISOString(),
  };
  map.set(id, next);
  return next;
}

export function createNode(
  workspaceSlug: string,
  partial: Partial<KnowledgeNode> & {
    title: string;
    kind: KnowledgeNode["kind"];
    parent_id: string | null;
  },
): KnowledgeNode {
  const map = nodesForWorkspace(workspaceSlug);
  const ws = workspaceStore.get(workspaceSlug);
  if (!ws) throw new Error(`Workspace "${workspaceSlug}" not found`);

  const id = `n-${Math.random().toString(36).slice(2, 10)}`;
  const baseSlug = slugify(partial.slug ?? partial.title);

  // Ensure slug is unique within the workspace. Empty / punctuation-only
  // titles fall back to the node id straight away.
  const slug = uniqueSlugInWorkspace(map, baseSlug, id);

  // Determine position among siblings
  let maxPos = 0;
  for (const v of map.values()) {
    if (v.parent_id === partial.parent_id && v.position > maxPos) {
      maxPos = v.position;
    }
  }

  const node: KnowledgeNode = {
    id,
    workspace_id: ws.id,
    parent_id: partial.parent_id,
    kind: partial.kind,
    slug,
    title: partial.title,
    content_md: partial.content_md ?? "",
    data: partial.data ?? {},
    tags: partial.tags ?? [],
    status: partial.status ?? null,
    priority: partial.priority ?? null,
    assignee_id: null,
    // Settable on create: a goal's horizon ends in this column, and the demo
    // backend has to behave like the real one or every goal test lies.
    due_date: partial.due_date ?? null,
    position: maxPos + 1,
    created_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  map.set(id, node);
  return node;
}

export function deleteNode(workspaceSlug: string, id: string): boolean {
  const map = nodesForWorkspace(workspaceSlug);
  const toDelete = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of map.values()) {
      if (n.parent_id && toDelete.has(n.parent_id) && !toDelete.has(n.id)) {
        toDelete.add(n.id);
        changed = true;
      }
    }
  }
  for (const x of toDelete) map.delete(x);
  return true;
}
