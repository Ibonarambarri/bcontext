/**
 * MCP server factory. Each authenticated `/mcp` request gets a fresh
 * server bound to the caller's workspace and scopes (stateless mode).
 *
 * Tools route through the Storage abstraction (`src/lib/storage`), which
 * picks the Supabase backend when the workspace is persisted and falls back
 * to the in-memory demo store otherwise. Retrieval (RAG) uses pgvector when
 * Supabase + AI Gateway are configured.
 *
 * Layout: `TOOLS` (the static catalogue agents see in `tools/list`, filtered
 * per principal by scope and grants), `CAPABILITY_ROUTING_TOOLS` (the two
 * tools through which external tools and skills are found and called — the
 * external ones resolved per call from `@/lib/capabilities/catalog` and
 * invoked through the gateway), `SERVER_INSTRUCTIONS` (the conventions sent
 * at `initialize`), and `buildMcpServer`, whose `tools/call` handler is one
 * large switch over the tool name. Tool descriptions are product text agents
 * read: change them with the plugin `SKILL.md` and `docs/` in mind.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ElicitResult,
  type Prompt,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Scope } from "@bcontext-dev/contract/auth/scopes";
import { isTerminalStatus } from "@bcontext-dev/contract/types";
import { hasScope } from "@bcontext-dev/contract/auth/scopes";
import {
  retrieveScoped,
  groupHitsByNode,
  refForHit,
} from "@/lib/rag";
import { RetrievalScopeSchema } from "@/lib/rag/scope";
import { chatModel } from "@/lib/ai/models";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { findBacklinks, findForwardLinks } from "@bcontext-dev/contract/backlinks";
import { appUrl } from "@/lib/env";
import { redactCredentialForAgents } from "@/lib/credentials";
import {
  credentialEnvName,
  credentialRef,
  readCredential,
} from "@bcontext-dev/contract/credentials";
import { ENTITY_LINK_RELATION, rememberDismissedEntityLink } from "@/lib/nexo/entity-linker";
import { listChecklistItems, toggleChecklistItem } from "@/lib/checklist";
import { skeletonFor } from "@/lib/templates/kind-skeletons";
import {
  SUBTASK_LIMITS,
  SubtaskDraftSchema,
  SubtaskOpSchema,
  readSubtasks,
  subtaskCard,
  subtaskProgress,
  subtasksFromDrafts,
  withoutSubtasks,
} from "@bcontext-dev/contract/subtasks";
import { SUBTASK_KINDS, SubtaskError, writeSubtaskOp } from "@/lib/subtasks";
import { goalProgress, keyResultProgress } from "@bcontext-dev/contract/goals";
import {
  CONTRIBUTES_TO,
  GOAL_SCOPES,
  GoalError,
  GoalStatusSchema,
  KeyResultDraftSchema,
  KeyResultPatchSchema,
  goalCreateInput,
  readGoals,
  updateGoal,
  writeGoalOp,
} from "@/lib/goals";
import {
  DATASET_MAX_ROWS,
  DATASET_MAX_ROWS_PER_WRITE,
  DATASET_QUERY_DEFAULT_LIMIT,
  DATASET_QUERY_MAX_LIMIT,
  type DatasetQuery,
} from "@bcontext-dev/contract/datasets";
import {
  DATASET_SAMPLE_DEFAULT,
  DATASET_SAMPLE_MAX,
  DatasetError,
  appendRowsToDataset,
  createDataset,
  describeDatasetNode,
  queryDataset,
  readDatasetSchema,
  replaceDatasetRows,
  sampleDataset,
  attachSourceFile,
  withoutDataset,
} from "@/lib/datasets";
import { DatasetQuerySchema, DatasetRowsFields } from "@/lib/datasets/schemas";
import { titleHint } from "@/lib/mcp/title-hint";
import {
  ConflictError,
  NodeWriteError,
  TagConflictError,
  TagNotFoundError,
  TagRelationError,
  type Storage,
} from "@/lib/storage";
import { recordUsage } from "@/lib/organizations/meters";
import { recordMcpToolCall } from "@/lib/mcp/usage";
import { annotateRequest } from "@bcontext-dev/contract/correlation";
import { actorFields, reportApiError } from "@/lib/errors/report";
import { extractSkills, generate } from "@/lib/skills/generate";
import { resolveSkillForClient } from "@/lib/skills/get";
import { importSkill } from "@/lib/skills/import";
import { SkillError } from "@/lib/skills/template";
import { initialSkillData, skillVersion, withSkillVersionBump } from "@/lib/skills/version";
import {
  record as recordActivity,
  listChangePageForStorage,
} from "@/lib/activity";
import { changePayload } from "@bcontext-dev/contract/changes";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { listAuthorizedCapabilityTools } from "@/lib/capabilities/catalog";
import {
  isSkillRef,
  searchCapabilities,
  skillCandidates,
  skillMatchesRef,
} from "@/lib/mcp/capability-search";
import {
  CapabilityGatewayError,
  invokeAuthorizedCapability,
} from "@/lib/capabilities/gateway";
import {
  normalizeViewQuery,
  VIEW_QUERY_SCHEMA_VERSION,
  ViewPresentationSchema,
  ViewQuerySchema,
} from "@bcontext-dev/contract/views/schema";
import { matchViewQuery, resolveViewQuery } from "@/lib/views/resolver";
import { buildRoadmapPayload } from "@/lib/views/roadmap";
import { appendBlock, listBlocks, replaceBlock } from "@/lib/blocks";
import { buildBrief, readLastBriefAt, stampBriefAt } from "@/lib/mcp/brief";
import {
  type CapabilityAdminActor,
  CapabilityAdminError,
  CapabilityStatusInput,
  ConnectCapabilityInput,
  DisconnectCapabilityInput,
  DiscoverCapabilityInput,
  GrantCapabilityInput,
  ListCapabilitiesInput,
  RevokeCapabilityGrantInput,
  capabilityStatus,
  connectCapability,
  disconnectCapability,
  discoverCapability,
  grantCapability,
  listCapabilities,
  revokeCapabilityGrant,
} from "@/lib/capabilities/mcp-admin";
import {
  CapabilityProvenanceError,
  CapabilityProvenanceSchema,
  assertInvocationLinkable,
  capabilityProvenanceData,
  linkInvocationToNode,
} from "@/lib/capabilities/provenance";
import {
  createView,
  deleteView,
  duplicateView,
  getView,
  listViews,
  updateView,
  ViewConflictError,
  ViewForbiddenError,
  ViewNotFoundError,
} from "@/lib/views/store";
import { ForbiddenError, NodeOutOfReachError } from "@/lib/storage/scoped";
import type { ViewPrincipal } from "@bcontext-dev/contract/views/types";
import { VERBS, canGrant, type Grant, type Reach, type Verb } from "@/lib/auth/grants";
import { listAccess, grantAccess, revokeAccess, GrantError } from "@/lib/auth/admin";
import {
  inviteToWorkspace,
  listHeldInvitations,
  releaseInvitation,
  InvitationError,
} from "@/lib/auth/invitations";
import { buildInspectorRelations } from "@bcontext-dev/contract/node-inspector";
import { appendAudit } from "@/lib/audit";
import { recordAiUsageEvent, tokensFromUsage } from "@/lib/telemetry/ai-usage";
import { AskNexoInput, askNexo, resolveNexoSignals } from "@/lib/nexo/ask";

export interface McpContext {
  workspaceId: string;
  scopes: Scope[];
  tokenId: string;
  /** `<org>/<workspace>` — the full name of the workspace this token belongs to. */
  workspaceRef: string;
  /** Resolved storage instance bound to the workspace. */
  storage: Storage;
  /**
   * Whether the bearer was a workspace-scoped or user-scoped token. Affects
   * `list_workspaces` semantics: workspace tokens return a single-element
   * array; multi-workspace tokens return explicitly approved workspaces.
   */
  tokenScope: "workspace" | "user";
  /** Present iff `tokenScope === "user"`. */
  userId?: string;
  /** Durable identity shared by OAuth/token sessions. */
  agentId?: string;
  /**
   * The agent's display name, resolved once per request by the transport.
   * Every write the server records carries it, so the change feed can say
   * "Codex release agent" without a lookup — and still can when the agent
   * row is gone.
   */
  agentLabel?: string;
  /** AI-usage subject (token creator or user). null = unattributed (fail open). */
  subjectUserId: string | null;
  /**
   * The caller's effective permission. `ctx.storage` is already narrowed by it,
   * so tools rarely need this — except the admin ones, which have to reason
   * about what the caller may hand out, not just what it may read.
   */
  grant: Grant;
}

const NODE_KINDS = [
  "doc",
  "task",
  "decision",
  "meeting",
  "bug",
  "adr",
  "entity",
  "skill",
  "data",
  "credential",
  "goal",
] as const;

/**
 * How many nodes to scan when a filter has to be applied in memory.
 *
 * The same ceiling the reach filter uses. It is a ceiling, not a page size:
 * a workspace above it would silently lose rows again, which is why the
 * response reports `matched` and `truncated`.
 */
const LIST_SCAN_CEILING = 5000;

const NODE_FIELDS = [
  "id",
  "parent_id",
  "kind",
  "tags",
  "slug",
  "title",
  "status",
  "priority",
  "updated_at",
] as const;

const NODE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "blocked",
  "done",
  "archived",
] as const;

// ---- Tool schemas (zod, source of truth for runtime validation) ----------

const SearchNodesInput = z.object({
  query: z.string().min(1).max(2000),
  kinds: z.array(z.enum(NODE_KINDS)).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  scope: RetrievalScopeSchema.optional(),
}).strict();

const GetNodeInput = z.object({
  id: z.string().min(1),
  include_content: z.boolean().default(true),
  include_links: z.boolean().default(true),
}).strict();

// Coerce the literal string "null" / "" to JSON null. Some MCP clients
// (notably Claude Code with an OpenAPI-`nullable` inputSchema cached from
// before the JSON-Schema-2020 fix) stringify JSON null before sending; we
// accept both shapes so old sessions don't need to reconnect.
const NullableString = z.preprocess(
  (v) => (v === "null" || v === "" ? null : v),
  z.string().nullable(),
);

const ChangeContextInput = z.object({
  source: z.string().trim().min(1).max(500).optional(),
  sources: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
  references: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
  block_id: z.string().trim().min(1).max(200).optional(),
  review: z.object({
    status: z.enum(["pending", "accepted", "rejected"]),
    label: z.string().trim().min(1).max(200),
    review_url: z.string().trim().max(2000).nullable().optional(),
  }).strict().optional(),
}).strict();

const CreateNodeInput = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(NODE_KINDS),
  // Optional: omitted → root. (Was required-but-nullable, which cost every
  // agent creating a root node one failed round-trip.)
  parent_id: NullableString.optional(),
  content_md: z.string().optional(),
  status: z.enum(NODE_STATUSES).nullable().optional(),
  priority: z.enum(["low", "med", "high", "urgent"]).nullable().optional(),
  tag_ids: z.array(z.string().min(1)).max(100).optional(),
  // Subtasks are written by whoever creates the task, in the same call:
  // the creator has the context to write each summary, and the cost of
  // writing it is theirs — the server never generates one.
  subtasks: z.array(SubtaskDraftSchema).max(SUBTASK_LIMITS.count).optional(),
  // Where the content came from when it came back from an external tool:
  // the gateway's receipt (`_meta.bcontext_gateway.invocation_id`). Stored
  // under data.provenance and linked from capability_invocations.node_id.
  provenance: CapabilityProvenanceSchema.optional(),
  change_context: ChangeContextInput.optional(),
}).strict();

const UpdateNodeInput = z.object({
  id: z.string().min(1),
  // Optimistic-concurrency guard: pass the `updated_at` you last read.
  // Mismatch → the call fails with a 409-style conflict instead of
  // last-write-wins clobbering another session's edit. min(1): an empty
  // string (e.g. an unset $TS shell variable) must be an error, never a
  // silently-dropped guard.
  if_updated_at: z.string().min(1).optional(),
  patch: z.object({
    title: z.string().optional(),
    slug: z.string().optional(),
    parent_id: z.string().nullable().optional(),
    position: z.number().int().optional(),
    content_md: z.string().optional(),
    status: z.enum(NODE_STATUSES).nullable().optional(),
    priority: z.enum(["low", "med", "high", "urgent"]).nullable().optional(),
    due_date: z.string().datetime({ offset: true }).nullable().optional(),
    data: z.record(z.unknown()).optional(),
    tag_ids: z.array(z.string().min(1)).max(100).optional(),
  }).strict(),
  change_context: ChangeContextInput.optional(),
}).strict();

const DeleteNodeInput = z.object({
  id: z.string().min(1),
}).strict();

const ListNodesInput = z.object({
  // Omit to list the whole workspace tree. `parent_id: null` returns only
  // root nodes; a node id returns that node's direct children.
  parent_id: z
    .preprocess((v) => (v === "null" || v === "" ? null : v), z.string().nullable())
    .optional(),
  kind: z.enum(NODE_KINDS).optional(),
  status: z.enum(NODE_STATUSES).optional(),
  // Archived nodes are out of the way by default; ask for them with
  // status:"archived" or include_archived:true.
  include_archived: z.boolean().optional(),
  tag_ids: z.array(z.string().min(1)).max(100).optional(),
  tags: z.array(z.string().min(1)).max(100).optional(),
  tags_match: z.enum(["any", "all"]).default("any"),
  // true → only nodes whose blocked_by edges all point at done nodes
  // (or that have no blockers). The "what can I start now" filter.
  unblocked: z.boolean().optional(),
  // The full view query contract (what views(op=query) takes), merged with
  // the shortcuts above; a key named here wins over its shortcut. Described
  // as an opaque object on purpose: the contract is ~1.7 KB of schema that
  // every reader already pays for once in `views`, and paying it again here
  // would cost every agent on every turn. Validated on the call.
  query: z.record(z.unknown()).optional(),
  limit: z.number().int().min(1).max(2000).default(1000),
}).strict();

const ListTagsInput = z.object({ op: z.literal("list").optional() }).strict();
const CreateTagInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  // Optional tag_relations edges created atomically alongside the tag.
  // parent_ids: this tag becomes a CHILD of each given tag id (multi-parent
  // DAG allowed). related_ids: symmetric same-level association.
  parent_ids: z.array(z.string().min(1)).max(50).optional(),
  related_ids: z.array(z.string().min(1)).max(50).optional(),
}).strict();
// A partial edit; the handler refuses an empty one (a discriminated union
// cannot carry a refinement on its members).
const UpdateTagInput = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
}).strict();
const MergeTagsInput = z.object({
  source_id: z.string().min(1),
  target_id: z.string().min(1),
}).strict();
const DeleteTagInput = z.object({ id: z.string().min(1) }).strict();
const TAG_RELATION_KINDS = ["parent", "related"] as const;
const LinkTagsInput = z.object({
  from_tag_id: z.string().min(1),
  to_tag_id: z.string().min(1),
  relation: z.enum(TAG_RELATION_KINDS),
}).strict();
const SetNodeTagsInput = z.object({
  node_id: z.string().min(1),
  tag_ids: z.array(z.string().min(1)).max(100),
}).strict();

// The per-op view schemas live inline in ViewsInput/ViewsWriteInput below.

/**
 * Views, as two tools instead of eight.
 *
 * Grouped by resource AND by risk, not just by resource: reads and writes stay
 * apart so each can carry an honest annotation. A client that auto-approves
 * read-only tools and asks before destructive ones cannot do either if `views`
 * mixes `get` with `delete`.
 *
 * The eight separate tools also inlined the query contract four times over —
 * `create_view`, `update_view`, `resolve_view` and `resolve_query` together
 * were 6.8 KB of a 24 KB surface, most of it the same schema repeated. Every
 * agent paid for those copies on every turn.
 */
const ViewsInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list") }).strict(),
  z.object({ op: z.literal("get"), id: z.string().min(1) }).strict(),
  z.object({ op: z.literal("resolve"), id: z.string().min(1) }).strict(),
  z.object({ op: z.literal("query"), query: ViewQuerySchema }).strict(),
]);

const ViewsWriteInput = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create"),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    // A view an agent saves is for the team; "private" by default meant a view
    // that looked shared and was visible to one token only, and nothing said so.
    visibility: z.enum(["private", "workspace"]).default("workspace"),
    query: ViewQuerySchema,
    presentation: ViewPresentationSchema,
  }).strict(),
  z.object({
    op: z.literal("duplicate"),
    id: z.string().min(1),
    name: z.string().trim().min(1).max(120).optional(),
  }).strict(),
  z.object({
    op: z.literal("update"),
    id: z.string().min(1),
    expected_version: z.number().int().positive(),
    patch: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      visibility: z.enum(["private", "workspace"]).optional(),
      query: ViewQuerySchema.optional(),
      presentation: ViewPresentationSchema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    op: z.literal("delete"),
    id: z.string().min(1),
    expected_version: z.number().int().positive().optional(),
  }).strict(),
]);

/**
 * Administration, split read from write so each carries an honest annotation.
 *
 * `preview` is what makes a permission administrable without a screen in front
 * of you: before granting, ask what the reach actually reaches. Reusing the
 * saved-view query language means it costs nothing to implement and matches
 * what an admin already understands.
 */
// `service_account` is a capability principal that is neither a person nor a
// token-bearing agent — a Slack install, whose id `op=access` lists like any
// other principal's. That is how an admin narrows what the bot can search.
const PrincipalRefSchema = z.object({
  kind: z.enum(["user", "agent", "service_account"]),
  id: z.string().min(1),
}).strict();

const ReachSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }).strict(),
  z.object({ type: z.literal("query"), query: ViewQuerySchema }).strict(),
]);

const AdminInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("access") }).strict(),
  z.object({ op: z.literal("preview"), reach: ReachSchema }).strict(),
  z.object({ op: z.literal("held_invitations") }).strict(),
]);

const AdminWriteInput = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("grant"),
    principal: PrincipalRefSchema,
    verbs: z.array(z.enum(VERBS)).min(1),
    reach: ReachSchema,
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  }).strict(),
  z.object({ op: z.literal("revoke"), principal: PrincipalRefSchema }).strict(),
  z.object({
    op: z.literal("invite"),
    email: z.string().email(),
    name: z.string().max(200).nullable().optional(),
    verbs: z.array(z.enum(VERBS)).min(1),
    reach: ReachSchema,
    expires_in_days: z.number().int().min(1).max(90).optional(),
  }).strict(),
  z.object({ op: z.literal("release_invite"), invite_id: z.string().min(1) }).strict(),
]);

const SkillsInput = z.object({
  op: z.enum(["list", "get"]).default("list"),
  /** op=get: the skill node id (from op=list). */
  id: z.string().min(1).optional(),
  /** op=get: values for the skill's input_schema. */
  input: z.record(z.unknown()).default({}),
}).strict();

const SkillsWriteInput = z.object({
  op: z.literal("import"),
  name: z.string().min(1).max(100),
  /** SKILL.md-shaped markdown: frontmatter (`name`, `description`, `scopes`, `tools`, `input_schema`) + prompt body. */
  body_md: z.string().min(1),
  /** Where it came from (catalogue URL, repo path); kept in data.source. */
  source: z.string().max(2000).optional(),
}).strict();

const CapabilitiesInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list") }).merge(ListCapabilitiesInput),
  z.object({ op: z.literal("discover") }).merge(DiscoverCapabilityInput),
  z.object({ op: z.literal("status") }).merge(CapabilityStatusInput),
]);

const CapabilitiesWriteInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("connect") }).merge(ConnectCapabilityInput),
  z.object({ op: z.literal("disconnect") }).merge(DisconnectCapabilityInput),
  z.object({ op: z.literal("grant") }).merge(GrantCapabilityInput),
  z.object({ op: z.literal("revoke") }).merge(RevokeCapabilityGrantInput),
]);

// The two routing tools (`CAPABILITY_ROUTING_TOOLS`): find, then call by ref.
const CapabilitySearchInput = z.object({
  /** Words, a tool name, or an exact ref (returns that tool with its schema). `*` lists everything. */
  query: z.string().trim().min(1).max(200),
  /** Only this provider's tools; `skill` for the workspace's skills. */
  provider: z.string().trim().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(25).default(10),
}).strict();

const CapabilityCallInput = z.object({
  /** From capability_search: `<provider>/<capability>/<tool>` or `skill/<slug>`. */
  ref: z.string().trim().min(1).max(400),
  args: z.record(z.unknown()).default({}),
}).strict();


const AskRagInput = z.object({
  query: z.string().min(1).max(2000),
  k: z.number().int().min(1).max(20).default(6),
  // false → retrieval only (cheaper, no model call), same hits shape.
  synthesize: z.boolean().default(true),
  scope: RetrievalScopeSchema.optional(),
}).strict();

const RunSkillInput = z.object({
  skill_id: z.string().min(1),
  input: z.record(z.unknown()).default({}),
  model: z.string().optional(),
}).strict();

const ToggleChecklistInput = z.object({
  node_id: z.string().min(1),
  index: z.number().int().min(0),
  block_id: z.string().optional(),
  // Omit to toggle; pass true/false to set an explicit state (idempotent).
  checked: z.boolean().optional(),
  if_updated_at: z.string().min(1).optional(),
}).strict();

/**
 * Block writes: one H2 section at a time, spliced by exact offsets
 * (`@/lib/blocks`). The point is that two agents editing different sections
 * of the same node never conflict — a lost race is retried onto the fresh
 * body — while a pinned `if_updated_at` stays strict.
 */
const AppendBlockInput = z.object({
  node_id: z.string().min(1),
  heading: z.string().trim().min(1).max(200),
  body_md: z.string().max(100_000).default(""),
  if_updated_at: z.string().min(1).optional(),
}).strict();

const ReplaceBlockInput = z.object({
  node_id: z.string().min(1),
  block_id: z.string().min(1).max(200),
  body_md: z.string().max(100_000),
  // Rename the block; the old id is kept as a redirect for inbound links.
  heading: z.string().trim().min(1).max(200).optional(),
  if_updated_at: z.string().min(1).optional(),
}).strict();

const BriefInput = z.object({
  // Entries per list.
  top: z.number().int().min(1).max(50).default(10),
  // Override the remembered last_brief_at (ISO timestamp).
  since: z.string().min(1).optional(),
}).strict();

/**
 * Subtasks: the unit of work inside a task, addressed by id so an agent
 * edits ONE step without re-sending the task. Reads return cards (id,
 * title, summary, done) unless a single subtask is fetched; writes are the
 * contract's SubtaskOp, each branch merged with the node address and the
 * optional precondition.
 */
const SubtasksInput = z.object({
  op: z.enum(["list", "get"]),
  node_id: z.string().min(1),
  // op=get only.
  id: z.string().min(1).optional(),
}).strict();

// Flat on purpose, like LinksWriteInput: a five-branch `oneOf` restated
// node_id/if_updated_at per branch and cost 1.5 KB of every writer's turn.
// The per-op shape is enforced at call time by the contract's SubtaskOpSchema,
// whose error names the field the op actually needs.
const SubtasksWriteInput = z.object({
  op: z.enum(["add", "update", "delete", "toggle", "reorder"]),
  node_id: z.string().min(1),
  // Omit and a lost race is retried against a fresh read; pass the
  // updated_at you last read and a mismatch is a 409 instead.
  if_updated_at: z.string().min(1).optional(),
  // update/delete/toggle/reorder(one): the subtask id.
  id: z.string().min(1).optional(),
  // add
  title: z.string().optional(),
  summary: z.string().optional(),
  content_md: z.string().optional(),
  // add (insert index) / reorder(one) (target index)
  position: z.number().int().min(0).optional(),
  // update
  patch: z.object({
    title: z.string().optional(),
    summary: z.string().optional(),
    content_md: z.string().optional(),
  }).strict().optional(),
  // toggle: omit to flip
  done: z.boolean().optional(),
  // reorder(all): every current id once, in the new order
  ids: z.array(z.string().min(1)).optional(),
}).strict();

/**
 * Goals, as two tools for the same reason subtasks got two: the thing an agent
 * actually does with a goal is move ONE key result, and doing that through
 * `nodes_write` means re-sending `data` whole — every other key result
 * included — behind an `if_updated_at` it has to fetch first. Here it is one
 * call that names the number it changed.
 */
const GoalsInput = z.object({
  /** One goal instead of the tree. No `op` enum: there is one read here. */
  id: z.string().min(1).optional(),
  scope: z.enum(GOAL_SCOPES).optional(),
  status: GoalStatusSchema.optional(),
  /** Goals whose window has closed, or has not opened yet, are out by default. */
  include_inactive: z.boolean().optional(),
}).strict();

// Flat, like subtasks_write: six ops restating the node address and the
// precondition in a `oneOf` cost more than the fields they discriminate. The
// per-op requirements are checked on the call, where the error can name the
// field this op is missing.
const GoalsWriteInput = z.object({
  op: z.enum(["create", "update", "checkin", "add_kr", "update_kr", "remove_kr"]),
  /** Every op but create: the goal node id. */
  id: z.string().min(1).optional(),
  /** create; update to rename. */
  title: z.string().trim().min(1).max(200).optional(),
  /** create only — a goal's scope is decided once. Omitted: no parent and nothing it contributes to ⇒ company. */
  scope: z.enum(GOAL_SCOPES).optional(),
  parent_id: NullableString.optional(),
  /** create: the goal this one pushes forward (creates the edge, and makes this a project goal). */
  contributes_to: z.string().min(1).optional(),
  content_md: z.string().optional(),
  tag_ids: z.array(z.string().min(1)).max(100).optional(),
  /** create/update: the horizon. A cycle re-derives both dates; dates alone earn the label only if they land on a quarter. */
  cycle: z.string().trim().max(20).nullable().optional(),
  start: z.string().trim().max(10).nullable().optional(),
  end: z.string().trim().max(10).nullable().optional(),
  status: GoalStatusSchema.optional(),
  review_every: z.enum(["weekly", "monthly", "quarterly"]).optional(),
  /** create: the key results. Afterwards edit them one at a time. */
  key_results: z.array(KeyResultDraftSchema).max(10).optional(),
  /** checkin/update_kr/remove_kr: which key result. */
  key_result_id: z.string().min(1).optional(),
  /** checkin: the new value. */
  current: z.number().optional(),
  /** add_kr (name, baseline, target required) / update_kr (only what changes). */
  kr: KeyResultPatchSchema.optional(),
  if_updated_at: z.string().min(1).optional(),
}).strict();

/**
 * Datasets, as two tools for the same reason goals and subtasks got two: the
 * rows of a `data` node are not in the node. Reading one through `nodes` would
 * mean returning the table, which is the thing this whole model exists to stop
 * — a CSV of three thousand customers in the context of every read.
 *
 * The query language is the contract's `DatasetQuery`, restated here as zod so
 * the tool schema shows an agent what it can ask. It is inline rather than an
 * opaque object (which is what `nodes(op=list)` does with the view query)
 * because there is no other tool that documents this DSL: an agent that cannot
 * see the operators would fetch rows and filter them itself, which costs more
 * on one call than the schema costs on every turn.
 */
const DataInput = z.object({
  op: z.enum(["schema", "sample", "query"]),
  node_id: z.string().min(1),
  // op=sample: rows to return.
  limit: z.number().int().min(1).max(DATASET_SAMPLE_MAX).optional(),
  query: DatasetQuerySchema.optional(),
}).strict();

// Flat, like subtasks_write and goals_write: three ops that restate the node
// address in a `oneOf` cost more than the fields that discriminate them.
const DataWriteInput = z.object({
  op: z.enum(["create", "append_rows", "replace_rows"]),
  // Every op but create.
  node_id: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  // create: the one line that reaches the vector index.
  description: z.string().trim().max(1000).optional(),
  content_md: z.string().optional(),
  parent_id: NullableString.optional(),
  tag_ids: z.array(z.string().min(1)).max(100).optional(),
  // The rows themselves: objects, or a CSV file; `columns` overrides an
  // inferred type on create/replace_rows.
  ...DatasetRowsFields,
  // create: keep the original file alongside the rows.
  filename: z.string().min(1).max(200).optional(),
  if_updated_at: z.string().min(1).optional(),
}).strict();

const ListChangesInput = z.object({
  // ISO timestamp (exclusive). Omit for the most recent changes.
  since: z.string().optional(),
  // Only changes touching this node — "what happened to X" without
  // paging through a busy team feed.
  node_id: z.string().optional(),
  actor: z.array(z.enum(["human", "agent", "system"])).max(3).optional(),
  action: z.array(z.enum(["create", "update", "delete", "agent", "rename", "move", "workspace"])).max(7).optional(),
  kind: z.array(z.enum(NODE_KINDS)).max(NODE_KINDS.length).optional(),
  tag_id: z.string().min(1).optional(),
  source: z.string().min(1).max(500).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

const EDGE_RELATIONS = [
  "blocked_by",
  "references",
  "caused_by",
  "relates_to",
  // from_id supersedes to_id — the older node is not deleted, just
  // flagged/degraded in retrieval (see src/lib/rag/staleness.ts).
  "supersedes",
  // from_id pushes to_id forward. N per node, unlike parent_id: one objective
  // lives under a single parent but can genuinely move several others.
  "contributes_to",
] as const;

const LinkNodesInput = z.object({
  from_id: z.string().min(1),
  to_id: z.string().min(1),
  relation: z.enum(EDGE_RELATIONS),
}).strict();

const AttachFileInput = z.object({
  node_id: z.string().min(1),
  filename: z.string().min(1).max(200),
  content_base64: z.string().min(1),
  content_type: z.string().min(1),
}).strict();

const ListIngestCandidatesInput = z.object({
  status: z.enum(["pending", "accepted", "dismissed"]).optional(),
}).strict();

// accept and dismiss address a candidate the same way, by id.
const IngestCandidateRefInput = z.object({ id: z.string().min(1) }).strict();

// ---- Consolidated tool inputs --------------------------------------------

/**
 * The same grouping the view tools got: one tool per resource, split by risk.
 *
 * Reads and writes stay apart because an annotation has to be honest — a tool
 * that carries both `get` and `delete` can be neither `readOnlyHint` nor
 * `destructiveHint`, and a client that auto-approves reads is then forced to
 * prompt for all of them. The branches are the *same* schemas the separate
 * tools used, merged with an `op` discriminant, so no argument changes shape.
 *
 * `change_context` repeats between create and update; `dedupeSubSchemas`
 * hoists it into `$defs` automatically, which is where the bytes actually go.
 */
const NodesInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get") }).merge(GetNodeInput),
  z.object({ op: z.literal("list") }).merge(ListNodesInput),
  z.object({ op: z.literal("search") }).merge(SearchNodesInput),
]);

const TagsWriteInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create") }).merge(CreateTagInput),
  z.object({ op: z.literal("update") }).merge(UpdateTagInput),
  z.object({ op: z.literal("merge") }).merge(MergeTagsInput),
  z.object({ op: z.literal("delete") }).merge(DeleteTagInput),
  z.object({ op: z.literal("link") }).merge(LinkTagsInput),
  z.object({ op: z.literal("unlink") }).merge(LinkTagsInput),
]);

// Both ops take exactly the same arguments, so a `oneOf` of two identical
// branches would only pay for the discriminant twice. A plain enum `op` says
// the same thing in a third of the bytes; the union shape is for groups whose
// branches genuinely differ.
const LinksWriteInput = z.object({
  op: z.enum(["link", "unlink"]),
}).merge(LinkNodesInput);

const IngestWriteInput = z.object({
  op: z.enum(["accept", "dismiss"]),
}).merge(IngestCandidateRefInput);

const NodesWriteInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create") }).merge(CreateNodeInput),
  z.object({ op: z.literal("update") }).merge(UpdateNodeInput),
  z.object({ op: z.literal("delete") }).merge(DeleteNodeInput),
  z.object({ op: z.literal("toggle_checklist_item") }).merge(ToggleChecklistInput),
  z.object({ op: z.literal("append") }).merge(AppendBlockInput),
  z.object({ op: z.literal("replace_block") }).merge(ReplaceBlockInput),
  z.object({ op: z.literal("attach_file") }).merge(AttachFileInput),
  // Assigning tags to a node changes the NODE, not the taxonomy, so it needs
  // nodes:write rather than admin. `requireWorkspaceAdmin` says as much itself:
  // "node-tag assignment remains a normal node write and does not use this
  // gate". Leaving it in `tags_write` forced that tool to stay visible to
  // anyone holding `write`, which defeated the filtering for every genuinely
  // taxonomic op sitting beside it.
  z.object({ op: z.literal("set_node_tags") }).merge(SetNodeTagsInput),
]);

/**
 * What an agent gets INSTEAD of a credential's values.
 *
 * Reading a secret over MCP would write it to the client's transcript on
 * disk, replay it to the model provider every following turn, and leak it
 * into any session log — three copies nobody rotates. So `nodes(op=get)` on a
 * credential returns its shape plus this: the reference for each field and
 * the one-line shell that materialises the value straight into the process
 * that needs it, without the value ever passing through the conversation.
 */
function credentialUse(node: { id: string; title: string; data?: unknown }, workspaceRef: string) {
  const credential = readCredential(node.data);
  const base = appUrl() ?? "$BCONTEXT_API";
  const endpoint = `${base}/api/credentials/${node.id}/materialize?workspace=${encodeURIComponent(workspaceRef)}`;
  const first = credential.fields.find((field) => field.secret) ?? credential.fields[0] ?? null;
  const envName = first ? credentialEnvName(credential, first, node.title) : "SECRET";
  const fieldKey = first?.key ?? first?.name ?? "<field>";
  return {
    refs: credential.fields.map((field) => ({
      field: field.key ?? field.name,
      ref: credentialRef(node.id, field.key ?? field.name),
    })),
    how: "Never read a credential's value into your context: it would be written to your transcript and replayed to the model on every later turn. Materialise it inside the command that uses it, and never echo it.",
    shell: `${envName}=$(curl -sS -H "Authorization: Bearer $BCONTEXT_MCP_TOKEN" "${endpoint}&field=${encodeURIComponent(fieldKey)}") <your command>`,
    dotenv: `curl -sS -H "Authorization: Bearer $BCONTEXT_MCP_TOKEN" "${endpoint}&format=env" > .env.local  # gitignored, then delete it`,
    requires_scope: "credentials:use",
  };
}

// ---- Tool descriptors -----------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: "nodes",
    description:
      "Read nodes. op=get fetches one node with its tags, links, typed dependencies and attachments (include_content/include_links=false to trim; keep updated_at for if_updated_at). op=list walks the workspace with parent_id/kind/status/tag filters (any|all) or a full `query` (the views(op=query) contract, merged with the shortcuts — query wins); tag filters inherit through the tag hierarchy, unblocked:true answers \"what can I start now\"; archived nodes stay out unless status:\"archived\"/include_archived:true. op=search is semantic + keyword; `scope` is an object ({schema_version:1,type:\"workspace\"|view|tags|selection|neighborhood|auto}, workspace by default) applied before retrieval; ONE hit per node, matching H2 blocks nested. op=get on a credential returns its shape only (values `[redacted]`) plus a `credential_use` recipe; credentials never appear in op=search. op=get on a `data` node returns its schema and row count, never its rows — those are the `data` tool's.",
    inputSchema: zodToJsonSchema(NodesInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "nodes_write",
    description:
      "Write nodes. op=create classifies with `tag_ids` and uses `parent_id` only for real hierarchy — `folder` and `category` are not node fields; H2 headings become addressable blocks and decision/adr/meeting/bug get a skeleton body. A task's steps go in `subtasks` (title + summary + content_md each) on the SAME create, not as separate task nodes. Titles are plain names: no `F01`/`NEXO-03` codes, no ` — ` separators. op=update takes fields INSIDE `patch` (unlike create, which is flat) and only touches supplied keys; patching content_md requires if_updated_at from your last read; on 409 re-fetch, rebase, retry. op=delete is irreversible and cascades to descendants. op=toggle_checklist_item flips one `- [ ]` by 0-based index (optionally scoped to a block_id) without rewriting the body. op=append adds an H2 block at the end (heading, body_md); op=replace_block rewrites one by block_id (body_md, heading to rename) — only that block is spliced, so edits to different blocks never conflict; if_updated_at optional (omitted → retried on a fresh read; given → 409). op=attach_file adds a base64 image (png/jpeg/webp/gif, ≤ 4 MB) and returns its URL. A `credential` node is ONE credential — one platform, one environment: data.credential = { type, environment, service } and data.fields = [{ key, name, value, secret }]; secrets never go in content_md, and values come back redacted.",
    inputSchema: zodToJsonSchema(NodesWriteInput),
    annotations: { destructiveHint: true },
  },
  {
    name: "subtasks",
    description:
      "A task's subtasks (steps INSIDE the node, not nodes). op=list → cards (id, title, summary, done) + progress; op=get (id) → one with full content_md. nodes(op=get) already returns them in full.",
    inputSchema: zodToJsonSchema(SubtasksInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "subtasks_write",
    description:
      "Edit ONE subtask of a task by id, without re-sending the task. op=add (title, summary, content_md, position?), op=update (id, patch), op=delete (id), op=toggle (id, done? — omit to flip), op=reorder (ids = full order, or id + position). You write the summary: it is what the card shows. if_updated_at optional: omitted, a lost race retries; given, a mismatch is a 409. task/bug nodes only.",
    inputSchema: zodToJsonSchema(SubtasksWriteInput),
    annotations: { destructiveHint: true },
  },
  {
    name: "goals",
    description:
      "What this workspace is aiming at: the tree (North Star \u2192 company \u2192 project) with each goal's status, progress aggregated from its key results, pace against its horizon and its contributes_to edges. Filter by scope/status; `id` returns one goal; include_inactive:true adds windows already closed.",
    inputSchema: zodToJsonSchema(GoalsInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "goals_write",
    description:
      "op=checkin (id, key_result_id, current, status?) moves ONE key result and stamps the review \u2014 no body rewrite, no if_updated_at. op=create (title, key_results, cycle \"2027-Q1\" or start/end, stored as due_date): no parent_id and no contributes_to means a company goal, parented to the North Star, and needs the goals:write verb. op=update renames, moves the horizon or sets status; scope is fixed at create. op=add_kr/update_kr take `kr`, op=remove_kr takes key_result_id. Statuses: on_track|at_risk|off_track|achieved|missed|abandoned, not the task ones.",
    inputSchema: zodToJsonSchema(GoalsWriteInput),
    annotations: { destructiveHint: true },
  },
  {
    name: "data",
    description:
      "Read a dataset (kind `data`): its rows live in their own table, so nodes(op=get) returns the schema and not the table. op=schema — columns and types, row count, whether the original file is kept. op=sample (limit, default " +
      `${DATASET_SAMPLE_DEFAULT}) — the first rows, which is what tells you \`plan\` means free|pro|enterprise. op=query — filter, sort, group and aggregate server-side; limit defaults to ${DATASET_QUERY_DEFAULT_LIMIT} and caps at ${DATASET_QUERY_MAX_LIMIT}. ` +
      "A column the schema does not have is an error naming the ones it does, never an empty answer.",
    inputSchema: zodToJsonSchema(DataInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "data_write",
    description:
      "Write a dataset. op=create (title, description, and `rows` or `csv`) makes the `data` node and its rows in one call; op=append_rows adds to one; op=replace_rows swaps the whole table and re-infers the schema — there is no delete_rows, because removing rows IS a replace. `rows` is [{column: value}]: an agent has rows from a query far more often than it has a file. Types are inferred per column; `columns` overrides a wrong guess. append_rows refuses a column the schema lacks — changing the shape is replace_rows. At most " +
      `${DATASET_MAX_ROWS_PER_WRITE} rows per write, ${DATASET_MAX_ROWS} per dataset. ` +
      "`description` is the only prose that reaches the index: it is what makes the dataset findable.",
    inputSchema: zodToJsonSchema(DataWriteInput),
    annotations: { destructiveHint: true },
  },
  {
    name: "tags",
    description:
      "List the active workspace tag taxonomy with stable ids, usage counts, and `relations` (the tag_relations graph: {id, from_tag_id, to_tag_id, relation}). relation 'parent' means from_tag_id is a CHILD of to_tag_id (a tag may have several parents); 'related' is a symmetric same-level association. Tag filters (nodes op=list, view queries, RAG tags scope) inherit downward: a parent tag matches nodes tagged with any descendant; 'related' never inherits. Read this before assigning tag_ids or editing the hierarchy.",
    inputSchema: zodToJsonSchema(ListTagsInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "tags_write",
    description:
      "Shape the taxonomy — any writer may (call `tags` first to reuse what exists; assigning tags to a node is nodes_write op=set_node_tags). op=create adds a tag, optionally with parent_ids (this tag becomes a CHILD of each — multi-parent DAG, cycles rejected) and related_ids (symmetric), atomically. op=update edits name and/or description (omitted keeps, null clears); a rename keeps the id and the old name as an alias. op=link/unlink add or remove one edge (relation parent|related; idempotent). op=merge folds source_id into target_id, MOVING every node assignment, and keeps the old id as a redirect; op=delete soft-deletes a tag and drops its assignments (nodes survive). merge/delete need tags:delete (admin). Tags classify; they never grant access.",
    inputSchema: zodToJsonSchema(TagsWriteInput),
    annotations: { destructiveHint: true },
  },
  {
    name: "views",
    description:
      "Read saved views. op=list, get, resolve (a saved view to node ids; the `roadmap` view adds `roadmap`: goals × now/next/later derived from status, priority and blockers, cards placed by `contributes_to` — move a card by editing the node, never the view), or query (resolve the shared query contract without saving). tags_any/tags_all inherit through the tag hierarchy: a parent tag matches nodes tagged with any descendant. A view holds a versioned query and presentation only — never node copies or embeddings.",
    inputSchema: zodToJsonSchema(ViewsInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "views_write",
    description:
      "Create, duplicate, update or delete a custom view. Query filters stay strictly separate from renderer/grouping/sorting/layout. Pass expected_version from views(op=get) on update and delete; a conflict means re-fetch and rebase. System views are immutable.",
    inputSchema: zodToJsonSchema(ViewsWriteInput),
    annotations: { destructiveHint: true },
  },
  {
    name: "admin",
    description:
      "Read who can reach this workspace. op=access lists every principal — people, agents and service accounts such as a Slack install, in one list — with their verbs, reach and who granted them. op=preview answers what a reach would actually reach before you grant it: how many nodes and which. op=held_invitations lists invitations an agent created that await release by a person. Requires the admin verb.",
    inputSchema: zodToJsonSchema(AdminInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "admin_write",
    description:
      "Grant, revoke or invite. op=grant sets one principal's verbs and reach (one per principal per workspace — granting again replaces it); op=revoke withdraws it. op=invite offers an address the verbs and reach it gets on accepting, so you can admit someone with no account yet; nothing is granted before they accept. An agent's invitation is HELD until a person calls op=release_invite. You can never hand out more than you hold, a wider reach than yours, or anything to yourself. Requires the admin verb, not given to agents by default.",
    inputSchema: zodToJsonSchema(AdminWriteInput),
    annotations: { destructiveHint: true },
  },
  {
    name: "capabilities",
    description:
      "External MCP servers/webhooks whose tools capability_search finds. op=list catalog and grants; op=discover an endpoint's tools before connecting; op=status of a capability (capability_id) or OAuth attempt (attempt_id; cancel:true abandons). Admin verb.",
    inputSchema: zodToJsonSchema(CapabilitiesInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "capabilities_write",
    description:
      "op=connect registers an endpoint as `key` (tools discovered; `tools` keeps a subset; api/workflow pass a webhook `contract`). auth.type bearer/header: token in auth.secret, write-only, never returned; oauth without attempt_id returns authorization_url for a person to consent, poll capabilities(op=status, attempt_id) until authorized, then reconnect with it. Connect grants nobody: op=grant gives a principal (default you) discover+invoke, allowed_tools narrows it; op=revoke one; op=disconnect removes it and its grants.",
    inputSchema: zodToJsonSchema(CapabilitiesWriteInput),
    annotations: { destructiveHint: true },
  },
  {
    name: "skills",
    description:
      "op=list: the skill nodes here (name, description, version, source id). op=get(id, input): the skill as instructions for you to run with your own model — prompt rendered with the validated input, the scopes it needs (refused if you lack one), the tools of this MCP it uses in order. Prefer it over skills_run.",
    inputSchema: zodToJsonSchema(SkillsInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "skills_write",
    description:
      "op=import: upsert a skill node from SKILL.md markdown, keyed by frontmatter name. New → version 1; a changed body bumps data.version; identical body is a no-op.",
    inputSchema: zodToJsonSchema(SkillsWriteInput),
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: "ask_rag",
    description:
      "Ask with cited retrieval. `scope` is an object ({schema_version:1,type:\"workspace\"|view|tags|selection|neighborhood|auto}); workspace is the default. Auto keeps a visible global candidate lane. Returns effective scope metadata and hits; broad graph neighbors are marked outside_scope. Pass synthesize:false for retrieval-only.",
    inputSchema: zodToJsonSchema(AskRagInput),
    // Retrieval plus an optional synthesis call: it reads the graph and never
    // writes to it. (It does meter AI usage, which is a ledger entry, not a
    // change to anything the caller can read back.)
    annotations: { readOnlyHint: true },
  },
  {
    name: "ask_nexo",
    description:
      "Ask the memory — the agent question tool (ask_rag is the primitive under it). Cited answer + confidence, freshness (stale/superseded), open conflicts on cited nodes, knowledge_gaps, suggested_actions, signals_pending. mode fast|deep|auto: deep also walks blocked_by/supersedes/references one level and cites the superseding node; auto picks deep for why/history questions or a stale top hit and reports mode_effective. Same `scope` as ask_rag. No AI gateway → answer null, note says so.",
    inputSchema: zodToJsonSchema(AskNexoInput),
    // Reads the graph and the NEXO signal tables; the only side effect is
    // the usage ledger, same as ask_rag.
    annotations: { readOnlyHint: true },
  },
  {
    name: "brief",
    description:
      "Start here: one read of the workspace. Returns {generated_at, since, counts:{nodes,by_kind,by_status}, unblocked:{total,top[]} (no live blocker, best priority first, ties by the goal each pushes, see `goal` on the card), open_decisions:{total,top[]} (status not terminal), for_you:{total,top[]} (assigned to you, open), goals:{total,north_star,top[],needs_review[],strategic_changes[]} (active; progress null \u2014 never 0 \u2014 when no key result is measurable; needs_review = past its declared cadence; strategic_changes = North Star/company goals touched since `since`), changes:{since,entries[],more} (since your previous brief, remembered per token; `since` overrides), views:[{id,name,renderer}], capabilities:{external_tools,skills} (what capability_search finds)}. `top` caps each list (default 10).",
    inputSchema: zodToJsonSchema(BriefInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_changes",
    description:
      "Workspace-scoped supervision feed shared with the Changes UI. Filter by human/agent actor, action, node kind/tag/id, source and date; paginate with cursor or re-sync with since. Entries include principal, correlation id, redacted before/after snapshots when recorded, provenance/references, affected relations, audit evidence, and `strategic` when the change touched the North Star or a company goal. Missing snapshots are explicit; generic rollback is never implied.",
    inputSchema: zodToJsonSchema(ListChangesInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "links_write",
    description:
      "Typed relations between two nodes. op=link creates one: blocked_by (from waits on to; `to` must carry a status — a task or bug, never a decision or doc — or it could never unblock), references, caused_by, relates_to, supersedes (from replaces to — to stays findable but is degraded in retrieval, never deleted). Prefer an edge over prose like 'depends on A9': edges power nodes(op=get)'s dependency status and nodes(op=list, unblocked:true). Direction matters — { from_id: TASK, to_id: BLOCKER, relation: 'blocked_by' } means TASK is blocked by BLOCKER. op=unlink removes one (exact from_id + to_id + relation match). Both are idempotent.",
    inputSchema: zodToJsonSchema(LinksWriteInput),
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: "ingest",
    description:
      "List the workspace's ingestion inbox — node candidates proposed by connector signals (decision/task/bug/adr), awaiting accept/dismiss. Filter by status; omit for all. Each candidate carries its own provenance and never mutates the graph until accepted.",
    inputSchema: zodToJsonSchema(ListIngestCandidatesInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "ingest_write",
    description:
      "Resolve one pending ingest candidate. op=accept creates the proposed node (stamped with ingest provenance in `data`) plus its declared links and marks the candidate accepted. op=dismiss creates nothing; the row is kept for traceability and won't be resurrected by a redelivered signal. Both fail if the candidate isn't pending.",
    inputSchema: zodToJsonSchema(IngestWriteInput),
    annotations: { destructiveHint: true },
  },
  {
    name: "skills_run",
    description:
      "Run a skill on the server with the server's model — for automations without one. Validates input, renders the prompt, returns the output. No tool calls, no graph writes. Agents: use skills(op=get).",
    inputSchema: zodToJsonSchema(RunSkillInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "ping",
    description: "Health check. Returns 'pong' and the workspace id.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_workspaces",
    description:
      "List the workspaces this token can access. Workspace tokens return their bound workspace; multi-workspace agent tokens return only explicitly approved workspaces. Use the returned `slug` in the `X-Bcontext-Workspace` request header to select the active workspace.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

/**
 * What each native tool needs before it is worth putting in front of a caller.
 *
 * A read-only agent was still being shown `nodes_write` and `tags_write`: it
 * paid for their schemas on every single turn, and had to learn by 403 that it
 * could not use them. Filtering `tools/list` by the principal's own verbs is
 * the one saving here that scales with how narrow the grant is — the tightest
 * agents, which are also the most numerous, pay the least.
 *
 * `ping` and `list_workspaces` are always advertised: a principal has to be
 * able to check it is alive and find out which workspace it is talking to,
 * whatever else it may not do.
 *
 * `tags_write` is pure taxonomy, so the filtering rule is clean: without a
 * `tags:*` verb the whole tool disappears. Writers hold `tags:create` and
 * `tags:update` (shaping the taxonomy is part of writing), so they see it;
 * only merge/delete inside it are refused to them, by verb, at the storage
 * seam. A reader never pays for it. Assigning tags to a node lives in
 * `nodes_write` — it changes the node, not the taxonomy.
 */
const ALWAYS_VISIBLE = new Set(["ping", "list_workspaces"]);
const READ_TOOLS = new Set([
  "brief",
  "nodes",
  "subtasks",
  "goals",
  "data",
  "tags",
  "views",
  "ingest",
  "skills",
  "skills_run",
  "ask_rag",
  "ask_nexo",
  "list_changes",
]);
// `goals_write` is a writer's tool, not an admin's: a principal with `write`
// creates and checks in on project goals with it. The strategic half of the
// surface refuses at the storage seam, which is where the verb is checked.
const WRITE_TOOLS = new Set(["nodes_write", "subtasks_write", "goals_write", "data_write", "links_write", "views_write", "ingest_write", "skills_write"]);
const ADMIN_TOOLS = new Set(["admin", "admin_write", "capabilities", "capabilities_write"]);

/**
 * How external tools and skills reach an agent: never inlined, always
 * through these two.
 *
 * Inlining a granted capability's tools into `tools/list` charged every turn
 * for every remote schema — a single GitHub server is 40 tools and 20 KB,
 * more than the whole native surface — and it made the list change under an
 * agent whenever a grant was added. Now `tools/list` is the native tools plus
 * exactly these, whatever the principal has been granted; `capability_search`
 * ranks what this caller may use (external tools by grant, the workspace's
 * skills) and hands back stable refs, `capability_call` re-resolves the ref
 * and routes it. Exported so the surface test can pin their cost.
 */
export const CAPABILITY_ROUTING_TOOLS: Tool[] = [
  {
    name: "capability_search",
    description:
      "Find the external tools and workspace skills you may call — none are in tools/list. Returns {hits:[{ref, kind: external|skill, provider?, title, description, input_schema?}], total, hint?}: input_schema comes inline when ≤3 hits or the query is an exact ref, otherwise search again by ref. Refs are stable: `<provider>/<capability>/<tool>`, `skill/<slug>`.",
    inputSchema: zodToJsonSchema(CapabilitySearchInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "capability_call",
    description:
      "Call one hit from capability_search by `ref` with `args` matching its input_schema. External refs are re-authorized on every call and run through the gateway; a `skill/…` ref runs the skill server-side (like skills_run). Do not retry unless the error says to.",
    inputSchema: zodToJsonSchema(CapabilityCallInput),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
];

export function visibleTools(grant: Grant): Tool[] {
  const has = (verb: Verb) => grant.verbs.includes(verb);
  const canWrite = has("write") || has("delete");
  const canTag = has("tags:create") || has("tags:update") || has("tags:delete");
  return TOOLS.filter((tool) => {
    if (ALWAYS_VISIBLE.has(tool.name)) return true;
    if (ADMIN_TOOLS.has(tool.name)) return has("admin");
    // The tag verbs open the taxonomy, not `write` itself: a grant row can
    // carry `write` without them (a narrowed grant an admin wrote by hand),
    // and then every tags_write call would be refused — the agent lab's
    // reviewer spent a turn on exactly that.
    if (tool.name === "tags_write") return canTag;
    if (WRITE_TOOLS.has(tool.name)) return canWrite;
    if (READ_TOOLS.has(tool.name)) return has("read");
    // Unclassified: fail closed rather than leak a tool nobody reasoned about.
    // `surface.test.ts` fails if a tool is ever left out of the lists above.
    return false;
  });
}

/**
 * Hoist repeated sub-schemas into `$defs` and reference them.
 *
 * The query contract is ~1.7 KB of JSON Schema and it appears twice inside
 * `views_write` alone (once for `create`, once inside `update`'s patch). That
 * duplication is paid by every agent on every turn, so it is worth removing —
 * but only where it repeats: a `$ref` used once is strictly worse than the
 * thing it points at, since it costs the definition plus the pointer.
 *
 * `$defs` and `$ref` are plain JSON Schema 2020-12, which is the dialect MCP
 * `inputSchema` already declares.
 */
function dedupeSubSchemas(root: Record<string, unknown>): Record<string, unknown> {
  const counts = new Map<string, number>();

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const obj = node as Record<string, unknown>;
    // Only object schemas are worth hoisting; primitives are shorter inline
    // than any reference to them could be.
    if (obj.type === "object" && obj.properties) {
      const key = JSON.stringify(obj);
      if (key.length > 400) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    Object.values(obj).forEach(visit);
  };
  visit(root);

  const repeated = [...counts.entries()].filter(([, n]) => n > 1);
  if (repeated.length === 0) return root;

  const defs: Record<string, unknown> = {};
  const nameFor = new Map<string, string>();
  repeated.forEach(([key], i) => {
    const name = `Def${i}`;
    nameFor.set(key, name);
    defs[name] = JSON.parse(key);
  });

  const replace = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(replace);
    const obj = node as Record<string, unknown>;
    const name = nameFor.get(JSON.stringify(obj));
    if (name) return { $ref: `#/$defs/${name}` };
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, replace(v)]));
  };

  return { ...(replace(root) as Record<string, unknown>), $defs: defs };
}

function zodToJsonSchema(schema: z.ZodTypeAny): Tool["inputSchema"] {
  // Minimal hand-rolled converter — produces a JSON Schema sufficient for
  // MCP's `inputSchema` field. Avoids the `zod-to-json-schema` dep for the
  // small shapes we actually expose.

  // A discriminated union becomes `oneOf`, which is what lets one tool carry
  // several operations without collapsing their arguments into a soup of
  // optional fields. The discriminant stays a `const` in each branch, so a
  // model reading the schema sees exactly which fields go with which op —
  // information a flat "everything optional" object would destroy.
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = [...schema.options] as z.ZodTypeAny[];
    return dedupeSubSchemas({
      type: "object",
      oneOf: options.map((option) => zodToJsonSchema(option)),
    }) as Tool["inputSchema"];
  }

  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const properties: { [key: string]: object } = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = describe(value as z.ZodTypeAny);
      if (!(value as z.ZodTypeAny).isOptional()) required.push(key);
    }
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }
  return { type: "object", properties: {}, additionalProperties: false };
}

function describe(schema: z.ZodTypeAny): { [key: string]: unknown } {
  // Unwrap defaults/optionals/preprocess wrappers.
  if (schema instanceof z.ZodDefault) return describe(schema._def.innerType);
  if (schema instanceof z.ZodOptional) return describe(schema._def.innerType);
  if (schema instanceof z.ZodEffects) return describe(schema._def.schema);
  if (schema instanceof z.ZodNullable) {
    // Emit a proper JSON Schema 2020-12 nullable type (`"type": [T, "null"]`)
    // rather than OpenAPI 3.0's `nullable: true`. MCP clients (Claude Code's
    // tool dispatcher in particular) validate strictly against JSON Schema,
    // so an OpenAPI `nullable` is ignored and `null` is coerced to the
    // string "null" before it ever reaches the server — which then explodes
    // when the column is a UUID.
    const inner = describe(schema._def.innerType);
    const innerType = inner.type;
    if (typeof innerType === "string") {
      return { ...inner, type: [innerType, "null"] };
    }
    if (Array.isArray(innerType)) {
      const types = innerType as string[];
      if (!types.includes("null")) {
        return { ...inner, type: [...types, "null"] };
      }
      return inner;
    }
    return inner;
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodLiteral) {
    // The discriminant of a union branch. `const` is more precise than a
    // one-element enum and reads as "this branch, exactly".
    return { type: "string", const: (schema as z.ZodLiteral<string>).value };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: (schema as z.ZodEnum<[string]>).options };
  }
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: describe(schema._def.type) };
  }
  if (schema instanceof z.ZodObject) {
    return zodToJsonSchema(schema) as Record<string, unknown>;
  }
  if (schema instanceof z.ZodRecord) {
    return { type: "object", additionalProperties: true };
  }
  return {};
}

// ---- Server -------------------------------------------------------------

/**
 * Canonical guidance string broadcast on the MCP `initialize` response.
 * Clients (Claude Code, Cursor, Claude Desktop) surface this to the model
 * once per session — it's the right place to teach the H2-block convention
 * instead of repeating it inside every tool description.
 */
const SERVER_INSTRUCTIONS = [
  "When creating or editing nodes, structure markdown with H2 headings (##). Each H2 section becomes a stable, addressable block under the node, referenced as `/n/<node_id>#<block_id>` where the block id is the slug of the heading text. This improves search precision and lets other agents (and humans) link to a specific section.",
  "",
  "Heading-derived blocks are automatic — you do not call a 'create block' tool. To create a new block, just write a new ## heading and the content under it. To rename a block, edit the heading text (the old block id is preserved as a redirect for inbound references). Prefer writing by block: nodes_write(op=append) adds a `## Result`-style section at the end and nodes_write(op=replace_block, block_id) rewrites one section, and neither conflicts with an edit to a different block of the same node.",
  "",
  "Concurrency: other sessions (human or agent) may edit nodes while you work. Patching content_md with nodes_write(op=update) REQUIRES `if_updated_at` (the updated_at from your last read); without it the call is refused and tells you the current value. A 409 means someone else wrote first: re-fetch, rebase, retry. To flip a single `- [ ]` item, prefer nodes_write(op=toggle_checklist_item) over rewriting the body.",
  "",
  "Start a session with brief: one read-only call returns counts, the unblocked queue by priority, open decisions, what is assigned to you, what changed since your previous brief (remembered per token) and the workspace's views. Re-sync cheaply: in long sessions, call list_changes({ since }) instead of re-reading the tree. The feed is workspace-scoped, redacts credentials/private reasoning, keeps operational snapshots for 180 days, and never implies universal rollback.",
  "",
  "Node semantics: kind says what a node is; reusable multi-value tags say what it is about; parent_id is optional real hierarchy between semantic nodes. Call tags before assigning tag_ids; if the tag you need is missing, create it with tags_write (any writer may create, describe and relate tags; only merge/delete are an admin's). `folder` and `category` are not node fields. Tags never grant permissions or replace workspace RLS.",
  "",
  "Archiving is cleanup, not deletion: status `archived` takes a task out of every view, board, graph and nodes(op=list) while keeping it readable by id (nodes op=get), linked and searchable. Archive what is finished or abandoned instead of leaving it to pile up; any other status brings it back. nodes(op=list, status:\"archived\") or include_archived:true lists them; an archived blocker no longer blocks. A task left in done for 30 days without changes is archived automatically.",
  "",
  "Titles are names, not codes. Say what the node is in plain words (`Queue worker on pg-boss`, `Realtime: move presence off Supabase`) — never a numbering or prefix (`F01`, `NEXO-03`, `P4-05`, `1.`) and no ` — ` separators. Codes mean something only to the session that wrote them and go stale when the plan changes; the id is the reference. The same goes for subtask titles. A write with a coded title still succeeds but returns `title_hint`.",
  "",
  "Saved views are versioned query lenses over canonical nodes. Read or resolve them with views(op=list|get|resolve); keep filters in query and renderer/grouping/sorting/layout in presentation. Views never copy nodes or embeddings, and never replace workspace/node permissions.",
  "",
  "Credentials are typed nodes and each one is EXACTLY ONE credential: `kind: \"credential\"`, with `data.credential = { schema_version: 1, type, environment, service }` and `data.fields = [{ key, name, value, secret }]`. `type` is one of api_key, api_key_pair, basic_auth, bearer_token, oauth2_client, cloud_keys, database, ssh_key, service_account, webhook, custom (custom is the edge case, not the default); `environment` is local|dev|staging|prod. Two platforms, or the same platform in dev and in prod, are TWO nodes told apart by environment and title — never one node holding several. Classify them with tags like anything else. Secret material lives only in `data.fields[].value`; never in content_md, never in a title.",
  "",
  "You will never be shown a credential's value. nodes(op=get) returns the shape — type, environment, which fields exist, which are secret, each field's `bx://credential/<node>#<field>` reference — with every value `[redacted]`, and credentials are excluded from search and retrieval. This is not distrust: anything you read is written to your client's transcript, replayed to the model provider on every later turn, and often summarised into a log, so a secret you read is a secret copied where nobody rotates it. To USE one, follow the `credential_use` recipe on the node: materialise the value inside the command that consumes it (`KEY=$(curl -sS ... /api/credentials/<node>/materialize?field=<key>) your-command`) or write it straight to a gitignored env file. Requires the `credentials:use` scope, which `admin:*` does not grant. Never echo, cat, print or paste a materialised value, and never copy one into a node, a commit, a PR or a message.",
  "",
  "Dependencies are structured, not prose: links_write({ op: 'link', from_id: TASK, to_id: BLOCKER, relation: 'blocked_by' }) instead of writing 'depends on X' in markdown. nodes(op=get) then reports blocker status and nodes({ op: 'list', unblocked: true }) answers 'what can I start now'. Screenshots and images attach via nodes_write(op=attach_file).",
  "",
  "A task is ONE node, and the steps to finish it are its subtasks — not more task nodes. Do not split one piece of work into 'phase 1/2/3' tasks: create one task with `subtasks` (each with a title, a one-line summary you write, and a full content_md), so reading the node gives everything needed to do the work and the graph only holds meaningful units. Then edit steps surgically with subtasks_write (add/update/delete/toggle/reorder by id) instead of rewriting the task; nodes(op=get) returns them in full and subtasks(op=list) returns the cards.",
  "",
  "Tools are grouped by resource and split by risk: the reads (`nodes`, `tags`, `views`, `ingest`, `skills`) never mutate, the `*_write` tools do. Pick the operation with `op`.",
  "",
  "Skills are capabilities of yours, not of the server: skills(op=get, id, input) returns a skill as instructions — prompt rendered with your input, the scopes it needs and the tools of this MCP it uses, in order — for you to execute with your own model; skills_run is for automations without a model, and skills_write(op=import) installs or updates a skill from SKILL.md markdown, bumping data.version.",
  "",
  "To ask the memory a question, call ask_nexo: it returns a cited answer with confidence, freshness (stale/superseded), open conflicts, knowledge gaps, suggested actions and how many ingest signals are still pending — ask_rag is the retrieval primitive underneath it.",
  "",
  "External tools (connected MCP servers, webhooks, workflows) and the workspace's skills are never in tools/list, so the list does not change when a grant is added: find them with capability_search (ranked over what you may call; refs are stable `<provider>/<capability>/<tool>` or `skill/<slug>`) and execute with capability_call(ref, args). Authorization is re-checked on every call. Do not retry an external action unless the returned error explicitly says to retry.",
  "",
  "With the admin verb, capabilities / capabilities_write discover, connect, grant and disconnect external MCP servers from here (OAuth comes back as a URL for a person to consent to, then poll op=status). What an external tool returns can be saved as context: nodes_write(op=create, provenance: { capability, tool, invocation_id }) with the invocation id from the result's _meta.bcontext_gateway.",
].join("\n");

export function buildMcpServer(ctx: McpContext): Server {
  const server = new Server(
    // The title names the workspace so a host that lists several Bcontext
    // servers (one per project folder) can tell them apart.
    { name: "bcontext", title: `Bcontext · ${ctx.workspaceRef}`, version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  const authorizedExternalTools = () =>
    listAuthorizedCapabilityTools({
      workspaceId: ctx.workspaceId,
      tokenId: ctx.tokenId,
      tokenScope: ctx.tokenScope,
      userId: ctx.userId,
      agentId: ctx.agentId,
    });

  /**
   * The workspace's skills as `capability_search` candidates. Reading them
   * needs `nodes:read` like `skills` does; a caller without it searches the
   * external tools only rather than being refused the whole search.
   */
  const searchableSkills = async () =>
    hasScope(ctx.scopes, "nodes:read")
      ? skillCandidates(await ctx.storage.listNodes({ kinds: ["skill"] }))
      : [];

  /**
   * One external call by ref. The ref is resolved against the catalog again
   * at invocation time instead of trusting an earlier search result, so
   * grant revocation and capability disablement are immediate.
   */
  const callExternal = async (
    ref: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    const external = (await authorizedExternalTools()).find((tool) => tool.ref === ref);
    if (!external) return errorText(`unknown or unauthorized ref: ${ref}`);
    const inputValidator = new AjvJsonSchemaValidator().getValidator(external.inputSchema as never);
    const validated = inputValidator(args);
    if (!validated.valid) return errorText(`invalid arguments: ${validated.errorMessage}`);
    try {
      return await invokeAuthorizedCapability(
        external,
        validated.data as Record<string, unknown>,
        { workspaceId: ctx.workspaceId, tokenId: ctx.tokenId, signal },
      ) as never;
    } catch (error) {
      if (error instanceof CapabilityGatewayError) {
        return errorText(
          `${error.code}: ${error.message}${error.retryAfterSec ? ` (retry after ${error.retryAfterSec}s)` : ""}`,
        );
      }
      throw error;
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Native tools are filtered by the principal's verbs; the two routing
    // tools are always there, and what they route to is resolved when called.
    // No catalog read here: the list must not depend on the grants.
    return { tools: [...visibleTools(ctx.grant), ...CAPABILITY_ROUTING_TOOLS] };
  });

  registerResources(server, ctx);
  registerPrompts(server, ctx);

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const rawArgs = normalizeIdAlias(name, req.params.arguments ?? {});

    // Every tool — native and external capability alike — passes through here,
    // so this is the one place metering belongs. It is deliberately counted
    // before the switch: what we want to know is how much a workspace asks of
    // the server, and a call that ends in a scope error still cost a request.
    // `recordMcpToolCall` only touches an in-process buffer and never throws,
    // so a read pays no round-trip for being measured and a broken counter can
    // never break a tool. See src/lib/mcp/usage.ts.
    //
    // The organization and the token's creator ride along because the same
    // flush feeds the organization's meter: reads are what an agent actually
    // does, and an administrator needs to see which agent is doing them.
    recordMcpToolCall(ctx.workspaceId, name, {
      organizationId: ctx.storage.workspace.organization_id,
      userId: ctx.subjectUserId,
    });
    // The counter says how much; the request log says what. `tool` and `op`
    // land on the transport's `request.completed` line (no-op outside an HTTP
    // request, e.g. the in-memory transport in tests), so "which tools do
    // agents use" is answerable from the log alone.
    annotateRequest({
      tool: name,
      op: typeof rawArgs.op === "string" ? rawArgs.op : undefined,
    });

    try {
      switch (name) {
        case "ping":
          return text(`pong (workspace=${ctx.workspaceRef || ctx.workspaceId})`);

        case "list_workspaces": {
          // Listing your own workspaces is a part of the token grant; no
          // scope check needed.
          const workspaces = await listAccessibleWorkspaces(ctx);
          return json({
            workspaces,
            active_slug: ctx.workspaceRef,
            token_scope: ctx.tokenScope,
            hint:
              ctx.tokenScope === "user"
                ? "Pass X-Bcontext-Workspace: <org>/<workspace> on each request to switch workspace, or connect to /mcp/<org>/<workspace> to fix it per project."
                : "This token is bound to one workspace; the active slug is fixed.",
          });
        }

        case "nodes": {
          ensureScope(ctx, "nodes:read");
          const input = NodesInput.parse(rawArgs);
          switch (input.op) {
          case "search": {
          const { query, kinds, limit, scope } = input;
          const ws = ctx.workspaceRef;
          // Overfetch only to collapse multiple matching H2 chunks into one
          // node. kinds/scope are resolved before either retrieval lane.
          const fetchK = Math.min(50, limit * 3);
          const result = await retrieveScoped(ws, query, {
            k: fetchK,
            scope,
            kinds,
            storage: ctx.storage,
            viewPrincipal: mcpViewPrincipal(ctx),
          });
          // One hit per node: block-level ranking is kept (nested under
          // `blocks`), but an agent never sees the same node 3× just
          // because 3 of its H2 sections matched.
          return json({ scope: result.scope, hits: groupHitsByNode(result.hits).slice(0, limit) });
          }
          case "get": {
          const { id, include_content, include_links } = input;
          const node = await ctx.storage.getNode(id);
          if (!node) return errorText(`node not found: ${id}`);
          // Bidirectional link resolution: inbound answers "what points at
          // this node?" — the way an agent discovers context it didn't
          // know to search for. One listNodes scan covers both directions.
          let links: {
            inbound_links: unknown[];
            outbound_links: unknown[];
            dependencies?: unknown;
          } | null = null;
          if (include_links) {
            const all = await ctx.storage.listNodeContext(node.id);
            const shape = (l: {
              id: string;
              title: string;
              kind: string;
              block_id: string | null;
              snippet: string;
            }) => ({
              node_id: l.id,
              title: l.title,
              kind: l.kind,
              block_id: l.block_id,
              snippet: l.snippet || null,
            });
            links = {
              inbound_links: findBacklinks(all, {
                id: node.id,
                slug: node.slug,
              }).map(shape),
              outbound_links: findForwardLinks(all, {
                id: node.id,
                content_md: node.content_md,
                data: node.data,
              }).map(shape),
            };
            // Typed-edge dependencies: blocked_by in both directions, with
            // each blocker's live status so agents can answer "can I start?"
            // without N follow-up reads. Always present (empty when no
            // edges) so consumers get a stable response shape.
            const edges = await ctx.storage.listEdges();
            const touching = edges.filter(
              (e) => e.from_node === node.id || e.to_node === node.id,
            );
            const shared = buildInspectorRelations(node, all, edges);
            const other = touching.filter((e) => e.relation !== "blocked_by");
            links.dependencies = {
              ...shared.dependencies,
              other_edges: other,
            };
          }
          const { readAttachments, attachmentUrl } = await import(
            "@/lib/attachments"
          );
          const attachments = readAttachments(node.data).map((a) => ({
            ...a,
            url: attachmentUrl(a.path),
          }));
          // Subtasks ride on data.subtasks; surface them once, at the top
          // level and in full, so one read of a task IS the work — and
          // strip them from `data` so the same bytes are not paid twice.
          const subtasks = readSubtasks(node.data);
          // A dataset answers with its SHAPE. This is half the reason the rows
          // moved out of `content_md`: reading a `data` node used to dump the
          // whole table into the agent's context, and the table is not what
          // the node knows — the columns and their types are.
          const dataset = node.kind === "data" ? describeDatasetNode(node) : null;
          const redacted = redactCredentialForAgents(node);
          return json({
            node: include_content
              ? { ...redacted, data: withoutDataset(withoutSubtasks(redacted.data)) }
              : Object.fromEntries(
                  NODE_FIELDS.map((f) => [f, node[f]]),
                ),
            ...(links ?? {}),
            attachments,
            ...(SUBTASK_KINDS.has(node.kind) || subtasks.length > 0
              ? {
                  subtasks: include_content ? subtasks : subtasks.map(subtaskCard),
                  subtasks_progress: subtaskProgress(subtasks),
                }
              : {}),
            ...(node.kind === "credential" ? { credential_use: credentialUse(node, ctx.workspaceRef) } : {}),
            ...(node.kind === "data"
              ? {
                  dataset: dataset
                    ? { columns: dataset.columns, row_count: dataset.row_count, source_file: dataset.source_file }
                    : null,
                }
              : {}),
          });
          }
          case "list": {
          const hasParentFilter = "parent_id" in input;
          // The shortcuts become a view query and the query is the filter:
          // ONE predicate, shared with saved views through `matchViewQuery`,
          // so nodes(list, unblocked:true) and a view with unblocked:true are
          // the same list by construction. A key the caller names in `query`
          // wins over its shortcut; `include_archived` widens `statuses` to
          // every status because the resolver hides archived by default.
          const shortcuts: Record<string, unknown> = { schema_version: VIEW_QUERY_SCHEMA_VERSION };
          if (input.kind) shortcuts.kinds = [input.kind];
          if (input.status) shortcuts.statuses = [input.status];
          else if (input.include_archived) shortcuts.statuses = [...NODE_STATUSES];
          if (input.unblocked !== undefined) shortcuts.unblocked = input.unblocked;
          const parsedQuery = ViewQuerySchema.safeParse({
            ...shortcuts,
            ...(input.query ?? {}),
            schema_version: VIEW_QUERY_SCHEMA_VERSION,
          });
          if (!parsedQuery.success) {
            const issues = parsedQuery.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ");
            return errorText(`invalid query: ${issues}. \`query\` takes the views(op=query) contract.`);
          }
          const query = normalizeViewQuery(parsedQuery.data);
          // kind, status and parent_id are applied in memory, so `limit`
          // cannot go to the database with them: it would truncate the
          // workspace FIRST and filter the leftovers, returning a handful of
          // matches and calling it the answer. Overfetch up to the scan
          // ceiling and apply `limit` after filtering, which is what the
          // caller asked for. The tag shortcuts stay in the storage query
          // (indexed, hierarchy-aware); the query's own tags_any/tags_all go
          // through the resolver. Both apply.
          const hasTagShortcut = Boolean(input.tag_ids || input.tags);
          const tagged = hasTagShortcut
            ? await ctx.storage.listNodeSummaries({
                limit: LIST_SCAN_CEILING,
                tagIds: input.tag_ids,
                tagSlugs: input.tags,
                tagsMatch: input.tags_match,
              })
            : null;
          // A tag filter may hide a task's blocker. Dependency evaluation
          // still needs the full workspace or the hidden blocker would be
          // mistaken for a stale/deleted node.
          const index = tagged && !query.unblocked
            ? tagged
            : await ctx.storage.listNodeSummaries({ limit: LIST_SCAN_CEILING });
          const matched = await matchViewQuery(ctx.storage, query, { nodes: index });
          let filtered = matched.nodes;
          if (tagged && index !== tagged) {
            const keep = new Set(tagged.map((n) => n.id));
            filtered = filtered.filter((n) => keep.has(n.id));
          }
          if (hasParentFilter) filtered = filtered.filter((n) => n.parent_id === input.parent_id);
          const page = filtered.slice(0, input.limit);
          return json({
            nodes: page.map((n) =>
              Object.fromEntries(NODE_FIELDS.map((f) => [f, n[f]])),
            ),
            // `matched` vs the page length is how a caller knows the list is
            // cut short. Silently returning fewer is what made the original bug
            // invisible for as long as it was.
            matched: filtered.length,
            truncated: filtered.length > page.length,
            filters: {
              tag_ids: input.tag_ids ?? [],
              tags: input.tags ?? [],
              tags_match: input.tags_match,
            },
          });
          }
          }
          break;
        }

        case "nodes_write": {
          ensureScope(ctx, "nodes:write");
          const input = NodesWriteInput.parse(rawArgs);
          switch (input.op) {
          case "create": {
          const { op: _op, ...payload } = input;
          if (input.subtasks && input.subtasks.length > 0 && !SUBTASK_KINDS.has(input.kind)) {
            return errorText(
              `subtasks belong to task or bug nodes, not a ${input.kind}. Put steps for a ${input.kind} in its body as \`- [ ]\` items instead.`,
            );
          }
          // The receipt has to be real and unclaimed before the node exists;
          // afterwards the link is best-effort (the node already carries it).
          if (input.provenance) await assertInvocationLinkable(ctx.workspaceId, input.provenance.invocation_id);
          const createData = {
            ...(input.subtasks && input.subtasks.length > 0
              ? { subtasks: subtasksFromDrafts(input.subtasks) }
              : input.kind === "skill" ? initialSkillData() : {}),
            ...(input.provenance ? { provenance: capabilityProvenanceData(input.provenance) } : {}),
          };
          const createArgs = {
            title: input.title,
            kind: input.kind,
            parent_id: input.parent_id ?? null,
            content_md: skeletonFor(input.kind, input.content_md),
            ...(Object.keys(createData).length > 0 ? { data: createData } : {}),
            // A status-less task/bug is invisible to every unblocked/status
            // sweep — an agent that forgets `status` creates work nobody
            // will ever surface. Default actionable kinds to todo, and a goal
            // to on_track: the goal vocabulary has no neutral value, and an
            // unstated one drops the goal out of every health filter.
            status:
              input.status ??
              (input.kind === "task" || input.kind === "bug"
                ? "todo"
                : input.kind === "goal"
                  ? ("on_track" as const)
                  : null),
            priority: input.priority ?? null,
            tag_ids: input.tag_ids,
          };
          // A goal created here goes through the same resolution as one created
          // by goals_write: scope decided once, company goals parented to the
          // North Star. Two paths that disagreed about that would be two
          // different meanings of `scope`, and the permission seam reads it.
          const node = await ctx.storage.createNode(
            input.kind === "goal" ? await goalCreateInput(ctx.storage, createArgs) : createArgs,
          );
          recordActivity(
            ctx.workspaceRef,
            "create",
            node.id,
            node.title,
            node.kind,
            {
              actorKind: "agent",
              actorId: ctx.userId ?? null,
              principalId: ctx.agentId ?? null,
              principalLabel: ctx.agentLabel ?? null,
              payload: changePayload({
                after: node,
                via: "mcp",
                source: input.change_context?.source,
                sources: input.change_context?.sources,
                references: input.change_context?.references,
                blockId: input.change_context?.block_id,
                review: input.change_context?.review
                  ? { ...input.change_context.review, review_url: input.change_context.review.review_url ?? null }
                  : null,
              }),
            },
          );
          appendMcpChangeAudit(ctx, "node.create", node.id, payload, { id: node.id, kind: node.kind });
          const invocationLinked = input.provenance
            ? await linkInvocationToNode({ workspaceId: ctx.workspaceId, invocationId: input.provenance.invocation_id, nodeId: node.id })
            : undefined;
          // Realtime fan-out: an MCP agent creating a node must show up live in
          // every connected tree, exactly like a human or REST create. Awaited
          // (not voided) so the broadcast POST lands before this function
          // returns — see server-broadcast.ts delivery note.
          if (ctx.storage.backend === "supabase") {
            await wsBroadcast.nodeCreated(ctx.storage.workspace.id, node.id);
          }
          const createdSubtasks = readSubtasks(node.data);
          const createHint = titleHint(node.title) ?? createdSubtasks.map((s) => titleHint(s.title)).find(Boolean) ?? null;
          return json({
            id: node.id,
            node: redactCredentialForAgents(node),
            ...(createHint ? { title_hint: createHint } : {}),
            ...(createdSubtasks.length > 0
              ? { subtasks: createdSubtasks.map(subtaskCard), subtasks_progress: subtaskProgress(createdSubtasks) }
              : {}),
            ...(invocationLinked !== undefined ? { invocation_linked: invocationLinked } : {}),
            // Embedding is async — a create-then-search in the same breath
            // will miss this node. nodes(op=get|list) see it immediately.
            indexing: "async (~15s until searchable)",
          });
          }
          case "update": {
          const { id, patch, if_updated_at, change_context } = input;
          const before = await ctx.storage.getNode(id);
          if (typeof patch.content_md === "string" && !if_updated_at) {
            // A body rewrite without a precondition is a lost-update
            // machine: in the agent lab, a builder's update replaced a
            // reviewer's notes and a planner's sign-off that had landed on
            // the same node minutes earlier, and the response said nothing.
            // Rejecting costs the caller one retry with the timestamp handed
            // back here; accepting costs someone else their work. Metadata
            // patches (status, tags, title) touch no prose and stay free.
            return errorText(
              `precondition_required: patching content_md needs if_updated_at (the node's updated_at from your last read` +
                (before ? `, currently "${before.updated_at}"` : "") +
                `). Re-read, rebase your change onto the current body, and retry with it — or use op=toggle_checklist_item for a single checkbox.`,
            );
          }
          const node = await ctx.storage.updateNode(id, withSkillVersionBump(before, patch), {
            ifUpdatedAt: if_updated_at,
          });
          if (!node) return errorText(`node not found: ${id}`);
          const titleChanged =
            typeof patch.title === "string" &&
            before !== null &&
            patch.title.trim() !== before.title;
          const parentChanged =
            "parent_id" in patch &&
            before !== null &&
            patch.parent_id !== before.parent_id;
          const kind = titleChanged
            ? "rename"
            : parentChanged
              ? "move"
              : "update";
          const summary = titleChanged
            ? before
              ? `${before.title} → ${node.title}`
              : null
            : parentChanged
              ? "parent changed"
              : Object.keys(patch).join(", ") || null;
          recordActivity(
            ctx.workspaceRef,
            kind,
            node.id,
            node.title,
            summary,
            {
              actorKind: "agent",
              actorId: ctx.userId ?? null,
              principalId: ctx.agentId ?? null,
              principalLabel: ctx.agentLabel ?? null,
              payload: changePayload({
                before,
                after: node,
                via: "mcp",
                source: change_context?.source,
                sources: change_context?.sources,
                references: change_context?.references,
                blockId: change_context?.block_id,
                review: change_context?.review
                  ? { ...change_context.review, review_url: change_context.review.review_url ?? null }
                  : null,
              }),
            },
          );
          appendMcpChangeAudit(ctx, kind === "rename" ? "node.rename" : kind === "move" ? "node.move" : "node.update", node.id, patch, { changed: Object.keys(patch) });
          // Realtime fan-out: pick the most specific event so collaborators'
          // trees refresh once per kind of change instead of double-firing.
          // Awaited so the POST lands before this function returns.
          if (ctx.storage.backend === "supabase") {
            const wsId = ctx.storage.workspace.id;
            if (titleChanged) {
              await wsBroadcast.nodeRenamed(wsId, node.id, node.title);
            } else if (parentChanged) {
              await wsBroadcast.nodeMoved(wsId, node.id, node.parent_id);
            } else {
              await wsBroadcast.nodeUpdated(wsId, node.id);
            }
          }
          const updateHint = typeof patch.title === "string" ? titleHint(patch.title) : null;
          return json({ id: node.id, node: redactCredentialForAgents(node), ...(updateHint ? { title_hint: updateHint } : {}) });
          }
          case "delete": {
          const { id } = input;
          const existing = await ctx.storage.getNode(id);
          if (!existing) return errorText(`node not found: ${id}`);
          // Echo the blast radius: the cascade is documented but silent —
          // an irreversible op should report what it actually removed.
          const { collectSubtreeIds } = await import("@/lib/storage");
          const allNodes = await ctx.storage.listNodes();
          const subtree = collectSubtreeIds(allNodes, id);
          const titleOf = new Map(allNodes.map((n) => [n.id, n.title]));
          await ctx.storage.deleteNode(id);
          const deleteActor = {
            actorKind: "agent" as const,
            actorId: ctx.userId ?? null,
            principalId: ctx.agentId ?? null,
            principalLabel: ctx.agentLabel ?? null,
            payload: changePayload({ before: existing, via: "mcp" }),
          };
          recordActivity(
            ctx.workspaceRef,
            "delete",
            id,
            existing.title,
            existing.kind,
            deleteActor,
          );
          appendMcpChangeAudit(ctx, "node.delete", id, { id }, { deleted_count: subtree.length });
          // Cascaded children vanish from the DB silently — without their
          // own feed entries, an incremental-sync consumer watching a child
          // could never learn it was deleted. Capped so a huge cascade
          // doesn't fan out hundreds of activity inserts.
          for (const childId of subtree.slice(1, 51)) {
            recordActivity(
              ctx.workspaceRef,
              "delete",
              childId,
              titleOf.get(childId) ?? null,
              `cascade from ${existing.title}`,
              {
                ...deleteActor,
                payload: { ...deleteActor.payload, cascade_root: id },
              },
            );
          }
          // Realtime fan-out: a cascade delete can remove many nodes; clients
          // refetch the whole tree on any node event, so one nodeDeleted is
          // enough to repaint live. Awaited so the POST lands before returning.
          if (ctx.storage.backend === "supabase") {
            await wsBroadcast.nodeDeleted(ctx.storage.workspace.id, id);
          }
          return json({
            ok: true,
            id,
            deleted_count: subtree.length,
            ...(subtree.length > 1
              ? { deleted_ids: subtree.slice(0, 50) }
              : {}),
          });
          }
          case "toggle_checklist_item": {
          const args = input;
          // Read-modify-write guarded by updated_at. When the caller pinned
          // if_updated_at we honor it strictly (no retry — their read is the
          // contract). Otherwise we retry once on a lost race.
          for (let attempt = 0; ; attempt++) {
            const node = await ctx.storage.getNode(args.node_id);
            if (!node) return errorText(`node not found: ${args.node_id}`);
            const guard = args.if_updated_at ?? node.updated_at;
            const res = toggleChecklistItem(node.content_md, args);
            if (!res.ok) {
              return errorText(
                `${res.error}. Items: ${JSON.stringify(res.items.map((it) => ({ index: it.index, checked: it.checked, text: it.text, block_id: it.block_id })))}`,
              );
            }
            try {
              const updated = await ctx.storage.updateNode(
                args.node_id,
                { content_md: res.content_md },
                { ifUpdatedAt: guard },
              );
              if (!updated) return errorText(`node not found: ${args.node_id}`);
              recordActivity(
                ctx.workspaceRef,
                "update",
                updated.id,
                updated.title,
                `checklist: ${res.item.checked ? "☑" : "☐"} ${res.item.text}`,
                {
                  actorKind: "agent",
                  actorId: ctx.userId ?? null,
                  principalId: ctx.agentId ?? null,
                  principalLabel: ctx.agentLabel ?? null,
                  payload: changePayload({
                    before: node,
                    after: updated,
                    via: "mcp",
                    blockId: res.item.block_id,
                  }),
                },
              );
              appendMcpChangeAudit(ctx, "node.checklist.toggle", updated.id, { index: args.index, block_id: args.block_id, checked: args.checked }, { item: res.item });
              if (ctx.storage.backend === "supabase") {
                await wsBroadcast.nodeUpdated(
                  ctx.storage.workspace.id,
                  updated.id,
                );
              }
              return json({
                id: updated.id,
                item: res.item,
                updated_at: updated.updated_at,
              });
            } catch (err) {
              if (
                err instanceof ConflictError &&
                !args.if_updated_at &&
                attempt < 4
              ) {
                continue; // somebody else wrote between our read and write — re-read and re-toggle
              }
              throw err;
            }
          }
          }
          case "append":
          case "replace_block": {
          const args = input;
          // Read-modify-write on ONE block. A pinned if_updated_at is the
          // caller's contract and is honored strictly; unpinned, a lost race
          // is retried by re-applying the same edit onto the fresh body —
          // which is what lets two agents land edits on different blocks of
          // the same node. The one thing a retry must not do is overwrite a
          // change to the block being replaced: that is the real conflict.
          let seenBefore: string | null = null;
          for (let attempt = 0; ; attempt++) {
            const node = await ctx.storage.getNode(args.node_id);
            if (!node) return errorText(`node not found: ${args.node_id}`);
            const guard = args.if_updated_at ?? node.updated_at;
            const edit =
              args.op === "append"
                ? appendBlock(node.content_md, { heading: args.heading, body_md: args.body_md })
                : replaceBlock(node.content_md, node.data, {
                    block_id: args.block_id,
                    body_md: args.body_md,
                    heading: args.heading,
                  });
            if (!edit.ok) return errorText(edit.error);
            if (args.op === "replace_block") {
              const current = JSON.stringify(edit.before);
              if (seenBefore === null) seenBefore = current;
              else if (seenBefore !== current) {
                return errorText(
                  `409 conflict: block #${edit.before?.block_id ?? args.block_id} of ${args.node_id} changed while you were editing it (updated_at is now ${node.updated_at}). Re-read the block, reapply your change and retry.`,
                );
              }
            }
            try {
              const updated = await ctx.storage.updateNode(
                args.node_id,
                { content_md: edit.content_md },
                { ifUpdatedAt: guard },
              );
              if (!updated) return errorText(`node not found: ${args.node_id}`);
              const verb = args.op === "append" ? "added" : "replaced";
              recordActivity(
                ctx.workspaceRef,
                "update",
                updated.id,
                updated.title,
                `block: #${edit.block.block_id} ${verb}`,
                {
                  actorKind: "agent",
                  actorId: ctx.userId ?? null,
                  principalId: ctx.agentId ?? null,
                  principalLabel: ctx.agentLabel ?? null,
                  payload: changePayload({
                    before: node,
                    after: updated,
                    via: "mcp",
                    blockId: edit.block.block_id,
                  }),
                },
              );
              appendMcpChangeAudit(
                ctx,
                args.op === "append" ? "node.block.append" : "node.block.replace",
                updated.id,
                { block_id: args.op === "append" ? null : args.block_id, heading: args.heading ?? null },
                { block_id: edit.block.block_id, attempt },
              );
              if (ctx.storage.backend === "supabase") {
                await wsBroadcast.nodeUpdated(ctx.storage.workspace.id, updated.id);
              }
              return json({
                id: updated.id,
                block: edit.block,
                blocks: listBlocks(updated.content_md).map((b) => b.block_id),
                updated_at: updated.updated_at,
                ...(attempt > 0 ? { rebased: true } : {}),
              });
            } catch (err) {
              if (err instanceof ConflictError && !args.if_updated_at && attempt < 4) {
                continue; // somebody else wrote between our read and write — re-read and re-apply
              }
              throw err;
            }
          }
          }
          case "attach_file": {
          const args = input;
          const { attachFile, AttachmentError } = await import(
            "@/lib/attachments"
          );
          try {
            const { record, url, nodeTitle } = await attachFile(ctx.storage, {
              nodeId: args.node_id,
              filename: args.filename,
              contentBase64: args.content_base64,
              contentType: args.content_type,
              uploadedVia: "mcp",
            });
            const changedNode = await ctx.storage.getNode(args.node_id);
            recordActivity(
              ctx.workspaceRef,
              "update",
              args.node_id,
              nodeTitle,
              `attached ${record.filename}`,
              {
                actorKind: "agent",
                actorId: ctx.userId ?? null,
                principalId: ctx.agentId ?? null,
                principalLabel: ctx.agentLabel ?? null,
                payload: changePayload({ after: changedNode, via: "mcp" }),
              },
            );
            appendMcpChangeAudit(ctx, "node.attachment.create", args.node_id, { filename: args.filename, content_type: args.content_type }, { path: record.path });
            if (ctx.storage.backend === "supabase") {
              await wsBroadcast.nodeUpdated(
                ctx.storage.workspace.id,
                args.node_id,
              );
            }
            return json({
              ok: true,
              attachment: record,
              url,
              hint: `Embed in markdown as ![${record.filename}](${url})`,
            });
          } catch (err) {
            if (err instanceof AttachmentError) return errorText(err.message);
            throw err;
          }
          }
          case "set_node_tags": {
          ensureScope(ctx, "nodes:write");
          const before = await ctx.storage.getNode(input.node_id);
          const node = await ctx.storage.setNodeTags(input.node_id, input.tag_ids);
          recordActivity(
            ctx.workspaceRef,
            "update",
            node.id,
            node.title,
            "tags",
            {
              actorKind: "agent",
              actorId: ctx.userId ?? null,
              principalId: ctx.agentId ?? null,
              principalLabel: ctx.agentLabel ?? null,
              payload: changePayload({ before, after: node, via: "mcp" }),
            },
          );
          appendMcpChangeAudit(ctx, "node.tags.set", node.id, { tag_ids: input.tag_ids }, { tag_ids: node.tags.map((tag) => tag.id) });
          if (ctx.storage.backend === "supabase") {
            await wsBroadcast.nodeUpdated(ctx.storage.workspace.id, node.id);
          }
          return json({ node_id: node.id, tags: node.tags });
          }
          }
          break;
        }

        case "subtasks": {
          ensureScope(ctx, "nodes:read");
          const input = SubtasksInput.parse(rawArgs);
          if (input.op === "get" && !input.id) return errorText("op=get needs `id` (the subtask id)");
          const node = await ctx.storage.getNode(input.node_id);
          if (!node) return errorText(`node not found: ${input.node_id}`);
          const subtasks = readSubtasks(node.data);
          if (input.op === "get") {
            const subtask = subtasks.find((s) => s.id === input.id);
            if (!subtask) {
              return errorText(
                `subtask not found: ${input.id}. Known: ${subtasks.map((s) => `${s.id} (${s.title})`).join(", ") || "none"}`,
              );
            }
            return json({ node_id: node.id, updated_at: node.updated_at, subtask });
          }
          return json({
            node_id: node.id,
            title: node.title,
            status: node.status,
            updated_at: node.updated_at,
            progress: subtaskProgress(subtasks),
            subtasks: subtasks.map(subtaskCard),
          });
        }

        case "subtasks_write": {
          ensureScope(ctx, "nodes:write");
          const input = SubtasksWriteInput.parse(rawArgs);
          const { node_id, if_updated_at, ...rawOp } = input;
          // Drop the keys the caller did not send, then let the contract's
          // per-op schema say exactly which field this op is missing.
          const opParsed = SubtaskOpSchema.safeParse(
            Object.fromEntries(Object.entries(rawOp).filter(([, v]) => v !== undefined)),
          );
          if (!opParsed.success) {
            const issues = opParsed.error.issues.map((i) => `${i.path.join(".") || "op"}: ${i.message}`).join("; ");
            return errorText(`invalid arguments for op=${rawOp.op}: ${issues}`);
          }
          const op = opParsed.data;
          let res;
          try {
            res = await writeSubtaskOp(ctx.storage, node_id, op, { ifUpdatedAt: if_updated_at });
          } catch (err) {
            if (err instanceof SubtaskError) return errorText(err.message);
            throw err;
          }
          if (res.changed) {
            recordActivity(
              ctx.workspaceRef,
              "update",
              res.node.id,
              res.node.title,
              res.summary,
              {
                actorKind: "agent",
                actorId: ctx.userId ?? null,
                principalId: ctx.agentId ?? null,
                principalLabel: ctx.agentLabel ?? null,
                payload: changePayload({
                  before: res.before,
                  after: res.node,
                  via: "mcp",
                  extra: { subtask_id: res.subtask?.id ?? ("id" in op ? op.id : null), subtask_op: op.op },
                }),
              },
            );
            appendMcpChangeAudit(ctx, `node.subtask.${op.op}`, res.node.id, input, {
              subtask_id: res.subtask?.id ?? null,
              progress: subtaskProgress(res.subtasks),
            });
            if (ctx.storage.backend === "supabase") {
              await wsBroadcast.nodeUpdated(ctx.storage.workspace.id, res.node.id, undefined, {
                data: res.node.data,
                updated_at: res.node.updated_at,
              });
            }
          }
          const subtaskHint = res.subtask && (op.op === "add" || op.op === "update") ? titleHint(res.subtask.title) : null;
          return json({
            node_id: res.node.id,
            updated_at: res.node.updated_at,
            changed: res.changed,
            ...(subtaskHint ? { title_hint: subtaskHint } : {}),
            subtask: res.subtask ? (op.op === "toggle" || op.op === "reorder" ? subtaskCard(res.subtask) : res.subtask) : null,
            progress: subtaskProgress(res.subtasks),
            order: res.subtasks.map((s) => s.id),
          });
        }

        case "goals": {
          ensureScope(ctx, "nodes:read");
          const input = GoalsInput.parse(rawArgs);
          if (input.id) {
            // Asking for one goal by id ignores the filters on purpose: a
            // caller that named it wants it, not an empty answer explaining
            // that its window closed.
            const read = await readGoals(ctx.storage, { include_inactive: true });
            const goal = read.flat.find((card) => card.id === input.id);
            if (!goal) return errorText(`goal not found: ${input.id}`);
            return json({ goal });
          }
          const read = await readGoals(ctx.storage, {
            scope: input.scope,
            status: input.status,
            include_inactive: input.include_inactive,
          });
          // The North Star is already the trunk of the tree; naming it by id
          // rather than repeating the card keeps one goal from arriving twice.
          return json({
            north_star_id: read.north_star?.id ?? null,
            total: read.total,
            tree: read.tree,
          });
        }

        case "goals_write": {
          ensureScope(ctx, "nodes:write");
          const input = GoalsWriteInput.parse(rawArgs);
          const needsId = (): string => {
            if (!input.id) throw new GoalError("invalid", `op=${input.op} needs \`id\` (the goal node id)`);
            return input.id;
          };
          const needsKeyResult = (): string => {
            if (!input.key_result_id) {
              throw new GoalError("invalid", `op=${input.op} needs \`key_result_id\` (from goals(op=get))`);
            }
            return input.key_result_id;
          };
          const horizon = { cycle: input.cycle, start: input.start, end: input.end };

          if (input.op === "create") {
            if (!input.title) return errorText("op=create needs `title`");
            const created = await ctx.storage.createNode(
              await goalCreateInput(
                ctx.storage,
                {
                  title: input.title,
                  kind: "goal",
                  parent_id: input.parent_id ?? null,
                  content_md: skeletonFor("goal", input.content_md),
                  data: input.scope ? { scope: input.scope } : {},
                  // A goal with no status is invisible to every status sweep,
                  // exactly as a status-less task is. A new goal is on track
                  // until somebody says otherwise.
                  status: input.status ?? "on_track",
                  tag_ids: input.tag_ids,
                },
                {
                  contributes_to: input.contributes_to ?? null,
                  horizon,
                  key_results: input.key_results,
                  review_every: input.review_every,
                },
              ),
            );
            // The edge is what `contributes_to` means; the scope it implied is
            // already persisted, so a failure here cannot silently promote the
            // goal — it just leaves the link to be made again.
            if (input.contributes_to) {
              await ctx.storage.createEdge({
                from_node: created.id,
                to_node: input.contributes_to,
                relation: CONTRIBUTES_TO,
              });
            }
            recordActivity(ctx.workspaceRef, "create", created.id, created.title, created.kind, {
              actorKind: "agent",
              actorId: ctx.userId ?? null,
              principalId: ctx.agentId ?? null,
              principalLabel: ctx.agentLabel ?? null,
              payload: changePayload({ after: created, via: "mcp" }),
            });
            appendMcpChangeAudit(ctx, "node.create", created.id, input, { id: created.id, kind: created.kind });
            if (ctx.storage.backend === "supabase") {
              await wsBroadcast.nodeCreated(ctx.storage.workspace.id, created.id);
            }
            const createHint = titleHint(created.title);
            const read = await readGoals(ctx.storage, { include_inactive: true });
            return json({
              id: created.id,
              ...(createHint ? { title_hint: createHint } : {}),
              goal: read.flat.find((card) => card.id === created.id) ?? null,
            });
          }

          if (input.op === "update") {
            const id = needsId();
            const { before, node, changed } = await updateGoal(
              ctx.storage,
              id,
              {
                title: input.title,
                status: input.status,
                horizon,
                review_every: input.review_every,
                tag_ids: input.tag_ids,
              },
              { ifUpdatedAt: input.if_updated_at },
            );
            recordActivity(
              ctx.workspaceRef,
              typeof input.title === "string" && input.title !== before.title ? "rename" : "update",
              node.id,
              node.title,
              changed.join(", ") || null,
              {
                actorKind: "agent",
                actorId: ctx.userId ?? null,
                principalId: ctx.agentId ?? null,
                principalLabel: ctx.agentLabel ?? null,
                payload: changePayload({ before, after: node, via: "mcp" }),
              },
            );
            appendMcpChangeAudit(ctx, "node.goal.update", node.id, input, { changed });
            if (ctx.storage.backend === "supabase") {
              await wsBroadcast.nodeUpdated(ctx.storage.workspace.id, node.id);
            }
            const read = await readGoals(ctx.storage, { include_inactive: true });
            return json({
              id: node.id,
              updated_at: node.updated_at,
              changed,
              goal: read.flat.find((card) => card.id === node.id) ?? null,
            });
          }

          const id = needsId();
          const op =
            input.op === "checkin"
              ? (() => {
                  if (typeof input.current !== "number") {
                    throw new GoalError("invalid", "op=checkin needs `current` (the key result's new value)");
                  }
                  return { op: "checkin" as const, key_result_id: needsKeyResult(), current: input.current, status: input.status };
                })()
              : input.op === "add_kr"
                ? (() => {
                    const kr = input.kr;
                    if (!kr?.name || typeof kr.baseline !== "number" || typeof kr.target !== "number") {
                      throw new GoalError("invalid", "op=add_kr needs `kr` with name, baseline and target");
                    }
                    return {
                      op: "add_kr" as const,
                      kr: { name: kr.name, unit: kr.unit ?? null, baseline: kr.baseline, target: kr.target, current: kr.current, direction: kr.direction ?? "increase" },
                    };
                  })()
                : input.op === "update_kr"
                  ? (() => {
                      if (!input.kr || Object.keys(input.kr).length === 0) {
                        throw new GoalError("invalid", "op=update_kr needs `kr` with the fields to change");
                      }
                      return { op: "update_kr" as const, key_result_id: needsKeyResult(), kr: input.kr };
                    })()
                  : { op: "remove_kr" as const, key_result_id: needsKeyResult() };

          const res = await writeGoalOp(ctx.storage, id, op, { ifUpdatedAt: input.if_updated_at });
          recordActivity(ctx.workspaceRef, "update", res.node.id, res.node.title, res.summary, {
            actorKind: "agent",
            actorId: ctx.userId ?? null,
            principalId: ctx.agentId ?? null,
            principalLabel: ctx.agentLabel ?? null,
            payload: changePayload({
              before: res.before,
              after: res.node,
              via: "mcp",
              extra: { key_result_id: res.key_result?.id ?? null, goal_op: op.op },
            }),
          });
          appendMcpChangeAudit(ctx, `node.goal.${op.op}`, res.node.id, input, {
            key_result_id: res.key_result?.id ?? null,
          });
          if (ctx.storage.backend === "supabase") {
            await wsBroadcast.nodeUpdated(ctx.storage.workspace.id, res.node.id, undefined, {
              data: res.node.data,
              updated_at: res.node.updated_at,
            });
          }
          return json({
            id: res.node.id,
            updated_at: res.node.updated_at,
            status: res.node.status,
            key_result: res.key_result,
            progress: goalProgress(res.key_results),
            key_results: res.key_results.map((kr) => ({ ...kr, progress: keyResultProgress(kr) })),
          });
        }

        case "data": {
          ensureScope(ctx, "nodes:read");
          const input = DataInput.parse(rawArgs);
          if (input.op === "schema") {
            return json(await readDatasetSchema(ctx.storage, input.node_id));
          }
          if (input.op === "sample") {
            const { description, rows } = await sampleDataset(
              ctx.storage,
              input.node_id,
              input.limit ?? DATASET_SAMPLE_DEFAULT,
            );
            return json({ ...description, rows });
          }
          // `schema_version` is ours to stamp: it is the contract's version,
          // not a question the caller should have to answer.
          const query = { ...(input.query ?? {}), schema_version: 1 } as DatasetQuery;
          return json(await queryDataset(ctx.storage, input.node_id, query));
        }

        case "data_write": {
          ensureScope(ctx, "nodes:write");
          const input = DataWriteInput.parse(rawArgs);
          const rows = input.rows as Record<string, unknown>[] | undefined;

          if (input.op === "create") {
            if (!input.title) return errorText("op=create needs `title`");
            const created = await createDataset(ctx.storage, {
              title: input.title,
              description: input.description ?? null,
              content_md: input.content_md ?? "",
              parent_id: input.parent_id ?? null,
              tag_ids: input.tag_ids,
              csv: input.csv ?? null,
              rows: rows ?? null,
              columns: input.columns ?? null,
            });
            // The original file is optional and comes last: the rows are the
            // dataset, and a bucket that refuses the upload must not cost the
            // caller the rows it just wrote.
            let dataset = created.dataset;
            if (input.filename && input.csv) {
              dataset = await attachSourceFile(ctx.storage, created.node.id, {
                filename: input.filename,
                content: input.csv,
              });
            }
            recordActivity(ctx.workspaceRef, "create", created.node.id, created.node.title, created.node.kind, {
              actorKind: "agent",
              actorId: ctx.userId ?? null,
              principalId: ctx.agentId ?? null,
              principalLabel: ctx.agentLabel ?? null,
              payload: changePayload({ after: created.node, via: "mcp" }),
            });
            appendMcpChangeAudit(ctx, "node.create", created.node.id, { op: input.op, title: input.title }, {
              id: created.node.id,
              kind: created.node.kind,
              rows: created.rows_written,
            });
            if (ctx.storage.backend === "supabase") {
              await wsBroadcast.nodeCreated(ctx.storage.workspace.id, created.node.id);
            }
            const createHint = titleHint(created.node.title);
            return json({
              id: created.node.id,
              updated_at: created.node.updated_at,
              ...(createHint ? { title_hint: createHint } : {}),
              rows_written: created.rows_written,
              dataset,
            });
          }

          if (!input.node_id) return errorText(`op=${input.op} needs \`node_id\` (the data node)`);
          const write = { csv: input.csv ?? null, rows: rows ?? null, columns: input.columns ?? null };
          const res =
            input.op === "append_rows"
              ? await appendRowsToDataset(ctx.storage, input.node_id, write, { ifUpdatedAt: input.if_updated_at })
              : await replaceDatasetRows(ctx.storage, input.node_id, write, { ifUpdatedAt: input.if_updated_at });
          recordActivity(ctx.workspaceRef, "update", res.node.id, res.node.title, res.summary, {
            actorKind: "agent",
            actorId: ctx.userId ?? null,
            principalId: ctx.agentId ?? null,
            principalLabel: ctx.agentLabel ?? null,
            payload: changePayload({
              before: res.before,
              after: res.node,
              via: "mcp",
              // The rows are not in the node, so the change feed records what
              // moved rather than a diff of `data` that would say nothing.
              extra: { dataset_op: input.op, rows_written: res.rows_written },
            }),
          });
          appendMcpChangeAudit(ctx, `node.dataset.${input.op}`, res.node.id, { op: input.op }, {
            rows_written: res.rows_written,
            row_count: res.dataset.row_count,
          });
          if (ctx.storage.backend === "supabase") {
            await wsBroadcast.nodeUpdated(ctx.storage.workspace.id, res.node.id, undefined, {
              data: res.node.data,
              updated_at: res.node.updated_at,
            });
          }
          return json({
            node_id: res.node.id,
            updated_at: res.node.updated_at,
            rows_written: res.rows_written,
            dataset: res.dataset,
          });
        }

        case "tags": {
          ensureScope(ctx, "nodes:read");
          ListTagsInput.parse(rawArgs);
          const [tags, usage, relations] = await Promise.all([
            ctx.storage.listTags(),
            ctx.storage.countTagUsage(),
            ctx.storage.listTagRelations(),
          ]);
          return json({
            tags: tags.map((tag) => ({
              ...tag,
              usage_count: usage.get(tag.id) ?? 0,
            })),
            relations: relations.map((relation) => ({
              id: relation.id,
              from_tag_id: relation.from_tag_id,
              to_tag_id: relation.to_tag_id,
              relation: relation.relation,
            })),
          });
        }

        case "tags_write": {
          const input = TagsWriteInput.parse(rawArgs);
          switch (input.op) {
          case "create": {
          const { op: _op, parent_ids, related_ids, ...tagInput } = input;
          const tag = await ctx.storage.createTag(tagInput);
          if (ctx.storage.backend === "supabase") await wsBroadcast.graphChanged(ctx.storage.workspace.id, "taxonomy", "created", tag.id);
          let relations: Array<{ id: string; from_tag_id: string; to_tag_id: string; relation: string }> = [];
          if (parent_ids?.length || related_ids?.length) {
            try {
              const created = await ctx.storage.createTagRelations(tag.id, { parent_ids, related_ids });
              relations = created.map((relation) => ({
                id: relation.id,
                from_tag_id: relation.from_tag_id,
                to_tag_id: relation.to_tag_id,
                relation: relation.relation,
              }));
              if (ctx.storage.backend === "supabase") await wsBroadcast.graphChanged(ctx.storage.workspace.id, "taxonomy", "updated", tag.id);
            } catch (relationError) {
              // The tag itself was already created — surface the relation
              // failure so the caller can retry via link_tags instead of
              // silently dropping the requested hierarchy edge.
              if (relationError instanceof TagRelationError) {
                return errorText(
                  relationError.code === "cycle"
                    ? `tags_write(op=create): "${tag.name}" was created, but the requested parent_ids would create a cycle in the tag hierarchy — ${relationError.message}. Retry the parent edge with tags_write(op=link) after picking a non-cyclic parent.`
                    : `tags_write(op=create): "${tag.name}" was created, but a relation was rejected: ${relationError.message}`,
                );
              }
              if (relationError instanceof TagNotFoundError) {
                return errorText(
                  `tags_write(op=create): "${tag.name}" was created, but relation target tag not found or inactive: ${relationError.tagId}`,
                );
              }
              throw relationError;
            }
          }
          return json({ tag, relations });
          }
          case "update": {
          const { op: _op, id, ...patch } = input;
          if (patch.name === undefined && patch.description === undefined) {
            return errorText("tags_write(op=update): give a new name and/or description");
          }
          const tag = await ctx.storage.updateTag(id, patch);
          if (ctx.storage.backend === "supabase") await wsBroadcast.graphChanged(ctx.storage.workspace.id, "taxonomy", "updated", tag.id);
          return json({ tag });
          }
          case "merge": {
          const tag = await ctx.storage.mergeTags(input.source_id, input.target_id);
          if (ctx.storage.backend === "supabase") await wsBroadcast.graphChanged(ctx.storage.workspace.id, "taxonomy", "merged", input.source_id);
          return json({ tag, merged_id: input.source_id });
          }
          case "delete": {
          const ok = await ctx.storage.deleteTag(input.id);
          if (ok && ctx.storage.backend === "supabase") await wsBroadcast.graphChanged(ctx.storage.workspace.id, "taxonomy", "deleted", input.id);
          return ok ? json({ ok: true, id: input.id }) : errorText(`tag not found: ${input.id}`);
          }
          case "link": {
          const { from_tag_id, to_tag_id, relation } = input;
          try {
            const created = await ctx.storage.createTagRelations(from_tag_id, {
              parent_ids: relation === "parent" ? [to_tag_id] : undefined,
              related_ids: relation === "related" ? [to_tag_id] : undefined,
            });
            if (ctx.storage.backend === "supabase") await wsBroadcast.graphChanged(ctx.storage.workspace.id, "taxonomy", "updated", from_tag_id);
            appendMcpChangeAudit(ctx, "tag.relation.link", from_tag_id, { from_tag_id, to_tag_id, relation }, { created: created.length > 0 });
            return json({
              ok: true,
              relations: created.map((r) => ({
                id: r.id,
                from_tag_id: r.from_tag_id,
                to_tag_id: r.to_tag_id,
                relation: r.relation,
              })),
            });
          } catch (error) {
            if (error instanceof TagRelationError) {
              return errorText(
                error.code === "cycle"
                  ? `tags_write(op=link): this would create a cycle in the tag hierarchy — ${error.message}. Pick a different parent or remove the conflicting edge first.`
                  : `tags_write(op=link): ${error.message}`,
              );
            }
            if (error instanceof TagNotFoundError) {
              return errorText(`tags_write(op=link): tag not found or inactive: ${error.tagId}`);
            }
            throw error;
          }
          }
          case "unlink": {
          const { from_tag_id, to_tag_id, relation } = input;
          const removed = await ctx.storage.deleteTagRelation({ fromTagId: from_tag_id, toTagId: to_tag_id, relation });
          if (ctx.storage.backend === "supabase" && removed) await wsBroadcast.graphChanged(ctx.storage.workspace.id, "taxonomy", "updated", from_tag_id);
          appendMcpChangeAudit(ctx, "tag.relation.unlink", from_tag_id, { from_tag_id, to_tag_id, relation }, { removed });
          return json({ ok: true, removed });
          }
          }
          break;
        }

        case "views": {
          ensureScope(ctx, "nodes:read");
          const input = ViewsInput.parse(rawArgs);
          const principal = mcpViewPrincipal(ctx);
          switch (input.op) {
            case "list":
              return json({ views: await listViews(ctx.storage, principal) });
            case "get":
              return json({ view: await getView(ctx.storage, principal, input.id) });
            case "resolve": {
              const view = await getView(ctx.storage, principal, input.id);
              if (view.presentation.renderer !== "roadmap") {
                return json({ view, result: await resolveViewQuery(ctx.storage, view.query) });
              }
              // The roadmap is its rows, not its node ids: an agent asking for
              // it gets the same goals × horizons the web draws, with the
              // reason each card sits where it sits.
              const [index, edges] = await Promise.all([
                ctx.storage.listNodeSummaries({ limit: 5_000 }),
                ctx.storage.listEdges(),
              ]);
              const result = await resolveViewQuery(ctx.storage, view.query, { nodes: index, edges });
              const roadmap = await buildRoadmapPayload(ctx.storage, view, result.node_ids, index, edges);
              return json({ view, result, roadmap });
            }
            case "query":
              return json({ result: await resolveViewQuery(ctx.storage, input.query) });
          }
          break;
        }

        case "views_write": {
          ensureScope(ctx, "nodes:write");
          const input = ViewsWriteInput.parse(rawArgs);
          const principal = mcpViewPrincipal(ctx);
          switch (input.op) {
            case "create": {
              const { op: _op, ...payload } = input;
              return json({ view: await createView(ctx.storage, principal, payload) });
            }
            case "duplicate":
              return json({
                view: await duplicateView(ctx.storage, principal, input.id, input.name),
              });
            case "update":
              return json({
                view: await updateView(ctx.storage, principal, input.id, {
                  expected_version: input.expected_version,
                  ...input.patch,
                }),
              });
            case "delete":
              await deleteView(ctx.storage, principal, input.id, input.expected_version);
              return json({ ok: true, id: input.id });
          }
          break;
        }

        case "admin": {
          const input = AdminInput.parse(rawArgs);
          if (input.op === "access") {
            return json({ access: await listAccess(ctx.grant) });
          }
          if (input.op === "held_invitations") {
            // The token is deliberately part of this: the person releasing the
            // invitation is the one who has to deliver it.
            return json({ held: await listHeldInvitations(ctx.grant) });
          }
          // preview: resolve the reach through the same resolver a saved view
          // uses, so what an admin sees here is exactly what the grant will do.
          if (ctx.grant.reach.type !== "all" && !ctx.grant.verbs.includes("admin")) {
            return errorText('this principal lacks the "admin" permission in this workspace');
          }
          const reach = input.reach as Reach;
          if (reach.type === "all") {
            const all = await ctx.storage.listNodeSummaries({ limit: 5000 });
            return json({
              reaches: all.length,
              sample: all.slice(0, 10).map((n) => ({ id: n.id, title: n.title })),
              note: "unrestricted reach: every node in the workspace",
            });
          }
          const result = await resolveViewQuery(ctx.storage, reach.query);
          return json({
            reaches: result.node_ids.length,
            sample: result.node_ids.slice(0, 10),
            applied_filters: result.applied_filters,
          });
        }

        case "admin_write": {
          const input = AdminWriteInput.parse(rawArgs);
          if (input.op === "grant") {
            const reach = input.reach as Reach;
            const confirmation = await confirmPrivilegeWidening(server, ctx, {
              verbs: input.verbs,
              reach,
              question:
                `Grant ${input.verbs.join(", ")} with reach ${describeReach(reach)} ` +
                `to ${input.principal.kind} ${input.principal.id}? yes/no`,
            });
            if (!confirmation.ok) return errorText(confirmation.error);
            const granted = await grantAccess(ctx.grant, {
              principal: input.principal,
              verbs: input.verbs,
              reach,
              expiresAt: input.expires_at ?? null,
            });
            return json({ granted, elicitation: confirmation.elicitation });
          }
          if (input.op === "revoke") {
            await revokeAccess(ctx.grant, input.principal);
            return json({ ok: true, revoked: input.principal });
          }
          if (input.op === "invite") {
            const reach = input.reach as Reach;
            const confirmation = await confirmPrivilegeWidening(server, ctx, {
              verbs: input.verbs,
              reach,
              question:
                `Grant ${input.verbs.join(", ")} with reach ${describeReach(reach)} ` +
                `to ${input.email} (invitation, effective when they accept)? yes/no`,
            });
            if (!confirmation.ok) return errorText(confirmation.error);
            // The receipt is uniform on purpose — it says nothing about whether
            // the address was already a member, so inviting cannot be used to
            // enumerate who is.
            return json({
              invitation: await inviteToWorkspace(ctx.grant, {
                email: input.email,
                name: input.name ?? null,
                verbs: input.verbs,
                reach,
                expiresInDays: input.expires_in_days,
              }),
              elicitation: confirmation.elicitation,
            });
          }
          return json({ released: await releaseInvitation(ctx.grant, input.invite_id) });
        }

        case "skills": {
          ensureScope(ctx, "nodes:read");
          const args = SkillsInput.parse(rawArgs);
          if (args.op === "get") {
            if (!args.id) return errorText("op=get needs `id` (a skill node id from op=list)");
            const node = await ctx.storage.getNode(args.id);
            if (!node) return errorText(`skill not found: ${args.id}`);
            try {
              return json(resolveSkillForClient(node, args.input, ctx.scopes, nativeToolNames()));
            } catch (err) {
              if (err instanceof SkillError) return errorText(err.message);
              throw err;
            }
          }
          const nodes = await ctx.storage.listNodes();
          const byId = new Map(nodes.map((n) => [n.id, n]));
          const skills = extractSkills(nodes);
          return json({
            skills: skills.map((s) => ({
              name: s.name,
              description: s.description,
              version: skillVersion(byId.get(s.source_id)?.data),
              source_id: s.source_id,
            })),
          });
        }

        case "skills_write": {
          ensureScope(ctx, "nodes:write");
          const args = SkillsWriteInput.parse(rawArgs);
          let result;
          try {
            result = await importSkill(ctx.storage, args);
          } catch (err) {
            if (err instanceof SkillError) return errorText(err.message);
            throw err;
          }
          const { node } = result;
          if (result.changed) {
            recordActivity(
              ctx.workspaceRef,
              result.created ? "create" : "update",
              node.id,
              node.title,
              result.created ? node.kind : `skill import v${result.version}`,
              {
                actorKind: "agent",
                actorId: ctx.userId ?? null,
                principalId: ctx.agentId ?? null,
                principalLabel: ctx.agentLabel ?? null,
                payload: changePayload({ after: node, via: "mcp", source: args.source }),
              },
            );
            appendMcpChangeAudit(
              ctx,
              result.created ? "node.create" : "node.update",
              node.id,
              { op: "import", name: args.name, source: args.source ?? null },
              { id: node.id, version: result.version },
            );
            if (ctx.storage.backend === "supabase") {
              if (result.created) await wsBroadcast.nodeCreated(ctx.storage.workspace.id, node.id);
              else await wsBroadcast.nodeUpdated(ctx.storage.workspace.id, node.id);
            }
          }
          return json({
            id: node.id,
            name: args.name,
            version: result.version,
            created: result.created,
            changed: result.changed,
          });
        }

        case "ask_rag": {
          ensureScope(ctx, "chat:run");
          const { query, k, synthesize, scope } = AskRagInput.parse(rawArgs);
          // Counted against the organization that owns the workspace and
          // attributed to the token's creator, so an administrator can see
          // which agent is asking the model the most.
          if (ctx.storage.backend === "supabase") {
            void recordUsage(ctx.storage.workspace.organization_id, ctx.subjectUserId, "ai_queries");
          }
          const retrieval = await retrieveScoped(ctx.workspaceRef, query, {
            k,
            scope,
            storage: ctx.storage,
            viewPrincipal: mcpViewPrincipal(ctx),
          });
          const hits = retrieval.hits;
          const shapedHits = hits.map((h, i) => ({
            n: i + 1,
            // Graph-expansion neighbors ride along beyond `k` — flag them
            // so callers know why the count can exceed the ask.
            ...((h as { expanded?: boolean }).expanded ? { expanded: true } : {}),
            ...(h.expansion_scope ? { expansion_scope: h.expansion_scope } : {}),
            ...(h.candidate_lanes ? { candidate_lanes: h.candidate_lanes } : {}),
            // Never hidden, only labeled — a stale or superseded hit is
            // still cited, but the caller must not present it as
            // uncontested current truth.
            ...(h.stale ? { stale: true } : {}),
            ...(h.superseded_by ? { superseded_by: h.superseded_by } : {}),
            node_id: h.node_id,
            title: h.title,
            kind: h.kind,
            score: h.similarity,
            block_id: h.block_id,
            // Ready-to-paste source anchor — every returned chunk is
            // verifiable and linkable, nothing arrives un-cited.
            ref: refForHit(h),
            snippet: h.content?.slice(0, 480) ?? null,
          }));
          // Synthesized answer with inline [N] citations that map to
          // hits[N-1]. This is what makes ask_rag a sensible FIRST call:
          // an answer you can act on, where every claim is verifiable.
          let answer: string | null = null;
          if (synthesize && hits.length > 0 && aiConfigured()) {
            try {
              const { generateText } = await import("ai");
              const model = chatModel();
              const context = hits
                .map(
                  (h, i) =>
                    `[${i + 1}] ${h.kind.toUpperCase()} · ${h.title} (${refForHit(h)})\n${(h.content ?? "").trim().slice(0, 1500)}`,
                )
                .join("\n\n---\n\n");
              const result = await generateText({
                model: languageModel(model),
                system:
                  "Answer strictly from the numbered context blocks. Cite every factual claim with its [N] marker inline. If the context doesn't answer the question, say so — never invent. Be concise (under 200 words).",
                prompt: `Question: ${query}\n\nContext:\n${context}`,
              });
              answer = result.text;
              if (ctx.storage.backend === "supabase") {
                void recordAiUsageEvent({
                  workspaceId: ctx.storage.workspace.id,
                  subjectUserId: ctx.subjectUserId,
                  surface: "ask_rag",
                  model,
                  tokens: tokensFromUsage(result.usage),
                });
              }
            } catch (err) {
              // Retrieval must never fail because synthesis did — degrade
              // to hits-only and tell the caller why there's no answer.
              answer = null;
              console.warn("[mcp] ask_rag synthesis failed:", err);
            }
          }
          return json({
            query,
            scope: retrieval.scope,
            answer,
            ...(synthesize && answer === null
              ? { answer_note: "synthesis unavailable (no gateway key, no hits, or model error) — hits below are still authoritative" }
              : {}),
            hits: shapedHits,
          });
        }

        case "ask_nexo": {
          ensureScope(ctx, "chat:run");
          const input = AskNexoInput.parse(rawArgs);
          // Same meter as ask_rag.
          if (ctx.storage.backend === "supabase") {
            void recordUsage(ctx.storage.workspace.organization_id, ctx.subjectUserId, "ai_queries");
          }
          // `ctx.storage` is the caller's grant made concrete: retrieval,
          // the relation walk and every node fetch go through it, so nothing
          // outside the reach ever reaches the rerank or the model.
          const result = await askNexo(input, {
            storage: ctx.storage,
            workspaceRef: ctx.workspaceRef,
            workspaceId: ctx.workspaceId,
            viewPrincipal: mcpViewPrincipal(ctx),
            subjectUserId: ctx.subjectUserId,
            signals: resolveNexoSignals(ctx.storage.backend, ctx.workspaceId),
            meter: ctx.storage.backend === "supabase",
          });
          return json(result);
        }

        case "brief": {
          ensureScope(ctx, "nodes:read");
          const input = BriefInput.parse(rawArgs);
          const since = input.since ?? (await readLastBriefAt(ctx.storage, ctx.tokenId));
          const brief = await buildBrief(
            {
              storage: ctx.storage,
              workspaceRef: ctx.workspaceRef,
              principalIds: [ctx.agentId, ctx.userId, ctx.subjectUserId].filter(
                (id): id is string => typeof id === "string" && id.length > 0,
              ),
              viewPrincipal: mcpViewPrincipal(ctx),
              countExternalTools: async () => (await authorizedExternalTools()).length,
            },
            { top: input.top, since },
          );
          // Stamped after the read so a brief that fails leaves `since` where
          // it was; the next call sees the same window again.
          await stampBriefAt(ctx.storage, ctx.tokenId, brief.generated_at);
          return json(brief);
        }

        case "list_changes": {
          ensureScope(ctx, "nodes:read");
          const input = ListChangesInput.parse(rawArgs);
          const changes = await listWorkspaceChanges(ctx, input);
          return json({
            changes: changes.entries,
            next_cursor: changes.next_cursor,
            retention: changes.retention,
            hint:
              "For incremental sync pass the newest `ts` back as `since`; for older history pass `next_cursor`. Snapshots are redacted and retained 180 days; audit hashes remain append-only.",
          });
        }

        case "links_write": {
          ensureScope(ctx, "nodes:write");
          const input = LinksWriteInput.parse(rawArgs);
          switch (input.op) {
          case "link": {
          const { from_id, to_id, relation } = input;
          if (from_id === to_id) {
            return errorText("links_write: a node cannot relate to itself");
          }
          // A blocked_by cycle deadlocks both tasks invisibly: neither ever
          // surfaces in nodes(op=list, unblocked: true). Reject at link time
          // with the offending path so the agent can restructure.
          if (relation === "blocked_by") {
            const edges = await ctx.storage.listEdges();
            const waitsOn = new Map<string, string[]>();
            for (const e of edges) {
              if (e.relation !== "blocked_by") continue;
              const list = waitsOn.get(e.from_node) ?? [];
              list.push(e.to_node);
              waitsOn.set(e.from_node, list);
            }
            const path = findPath(waitsOn, to_id, from_id);
            if (path) {
              return errorText(
                `links_write(op=link): this would create a blocked_by cycle (${[from_id, ...path].join(" → ")}) — both tasks would deadlock and never appear as unblocked. Restructure the dependency instead.`,
              );
            }
          }
          const fromNode = await ctx.storage.getNode(from_id);
          const toNode = await ctx.storage.getNode(to_id);
          // A blocked_by target that carries no status (decision/doc/entity)
          // can never reach done — the dependent would be
          // deadlocked forever, invisibly. Suggest `references` instead.
          if (relation === "blocked_by" && toNode && toNode.status === null) {
            return errorText(
              `links_write(op=link): "${toNode.title}" (${toNode.kind}) has no status and can never become done — a blocked_by edge to it would deadlock ${from_id} permanently. Use relation "references" for context links.`,
            );
          }
          await ctx.storage.createEdge({
            from_node: from_id,
            to_node: to_id,
            relation,
          });
          if (ctx.storage.backend === "supabase") await wsBroadcast.graphChanged(ctx.storage.workspace.id, "edge", "created", `${from_id}>${to_id}:${relation}`);
          recordActivity(
            ctx.workspaceRef,
            "update",
            from_id,
            fromNode?.title ?? null,
            `linked ${relation} → ${toNode?.title ?? to_id}`,
            {
              actorKind: "agent",
              actorId: ctx.userId ?? null,
              principalId: ctx.agentId ?? null,
              principalLabel: ctx.agentLabel ?? null,
              payload: changePayload({
                before: fromNode,
                after: fromNode,
                via: "mcp",
                relations: [{ operation: "link", from_id, to_id, relation }],
              }),
            },
          );
          appendMcpChangeAudit(ctx, "edge.link", from_id, { from_id, to_id, relation }, { linked: true });
          return json({ ok: true, edge: { from_id, to_id, relation } });
          }
          case "unlink": {
          const { from_id, to_id, relation } = input;
          const removed = await ctx.storage.deleteEdge({
            from_node: from_id,
            to_node: to_id,
            relation,
          });
          if (!removed) {
            // ok:true + removed:false reads as success — tell the caller
            // what edges actually exist between the pair so a wrong
            // --relation guess is self-correcting.
            const edges = await ctx.storage.listEdges();
            const between = edges.filter(
              (e) =>
                (e.from_node === from_id && e.to_node === to_id) ||
                (e.from_node === to_id && e.to_node === from_id),
            );
            return json({
              ok: true,
              removed: false,
              hint:
                between.length > 0
                  ? `no ${relation} edge from ${from_id} to ${to_id}; existing edges between the pair: ${between.map((e) => `${e.from_node === from_id ? "→" : "←"}${e.relation}`).join(", ")}`
                  : "no edges exist between these two nodes",
            });
          }
          const fromNode = await ctx.storage.getNode(from_id);
          // A human (or their agent) removed a reference NEXO may have
          // proposed: remember it so the entity linker does not put it back.
          if (relation === ENTITY_LINK_RELATION) await rememberDismissedEntityLink(ctx.storage, from_id, to_id);
          if (ctx.storage.backend === "supabase") await wsBroadcast.graphChanged(ctx.storage.workspace.id, "edge", "deleted", `${from_id}>${to_id}:${relation}`);
          recordActivity(
            ctx.workspaceRef,
            "update",
            from_id,
            fromNode?.title ?? null,
            `unlinked ${relation} → ${to_id}`,
            {
              actorKind: "agent",
              actorId: ctx.userId ?? null,
              principalId: ctx.agentId ?? null,
              principalLabel: ctx.agentLabel ?? null,
              payload: changePayload({
                before: fromNode,
                after: fromNode,
                via: "mcp",
                relations: [{ operation: "unlink", from_id, to_id, relation }],
              }),
            },
          );
          appendMcpChangeAudit(ctx, "edge.unlink", from_id, { from_id, to_id, relation }, { removed: true });
          return json({ ok: true, removed });
          }
          }
          break;
        }

        case "ingest": {
          ensureScope(ctx, "nodes:read");
          const args = ListIngestCandidatesInput.parse(rawArgs);
          if (ctx.storage.backend !== "supabase") return json({ candidates: [] });
          const { listCandidates } = await import("@/lib/ingest/candidates");
          const candidates = await listCandidates(ctx.workspaceId, { status: args.status });
          return json({ candidates });
        }

        case "ingest_write": {
          const input = IngestWriteInput.parse(rawArgs);
          switch (input.op) {
          case "accept": {
          ensureScope(ctx, "nodes:write");
          const args = input;
          if (ctx.storage.backend !== "supabase") {
            return errorText("ingest candidates require a persisted (Supabase) workspace");
          }
          const { acceptCandidate, IngestCandidateError } = await import(
            "@/lib/ingest/candidates"
          );
          try {
            const candidate = await acceptCandidate(ctx.storage, args.id, ctx.subjectUserId);
            appendMcpChangeAudit(
              ctx,
              "ingest_candidate.accept",
              candidate.created_node_id ?? args.id,
              { candidate_id: args.id },
              { node_id: candidate.created_node_id },
            );
            return json({ candidate });
          } catch (err) {
            if (err instanceof IngestCandidateError) return errorText(err.message);
            throw err;
          }
          }
          case "dismiss": {
          ensureScope(ctx, "nodes:write");
          const args = input;
          if (ctx.storage.backend !== "supabase") {
            return errorText("ingest candidates require a persisted (Supabase) workspace");
          }
          const { dismissCandidate, IngestCandidateError } = await import(
            "@/lib/ingest/candidates"
          );
          try {
            const candidate = await dismissCandidate(ctx.workspaceId, args.id, ctx.subjectUserId);
            return json({ candidate });
          } catch (err) {
            if (err instanceof IngestCandidateError) return errorText(err.message);
            throw err;
          }
          }
          }
          break;
        }

        case "skills_run": {
          ensureScope(ctx, "chat:run");
          const args = RunSkillInput.parse(rawArgs);
          const { runSkill, SkillError } = await import("@/lib/skills/run");
          try {
            const out = await runSkill(ctx.storage, args, undefined, ctx.subjectUserId);
            return json(out);
          } catch (err) {
            if (err instanceof SkillError) return errorText(err.message);
            throw err;
          }
        }

        case "capabilities": {
          requireAdminVerb(ctx);
          const input = CapabilitiesInput.parse(rawArgs);
          const actor = capabilityActor(ctx);
          switch (input.op) {
            case "list": {
              const { op: _op, ...args } = input;
              return json(await listCapabilities(actor, args));
            }
            case "discover": {
              const { op: _op, ...args } = input;
              return json(await discoverCapability(actor, args));
            }
            case "status": {
              const { op: _op, ...args } = input;
              return json(await capabilityStatus(actor, args));
            }
          }
          break;
        }

        case "capabilities_write": {
          requireAdminVerb(ctx);
          const input = CapabilitiesWriteInput.parse(rawArgs);
          const actor = capabilityActor(ctx);
          switch (input.op) {
            case "connect": {
              const { op: _op, ...args } = input;
              return json(await connectCapability(actor, args));
            }
            case "disconnect": {
              const { op: _op, ...args } = input;
              return json(await disconnectCapability(actor, args));
            }
            case "grant": {
              const { op: _op, ...args } = input;
              return json(await grantCapability(actor, args));
            }
            case "revoke": {
              const { op: _op, ...args } = input;
              return json(await revokeCapabilityGrant(actor, args));
            }
          }
          break;
        }

        case "capability_search": {
          const input = CapabilitySearchInput.parse(rawArgs);
          const [external, skills] = await Promise.all([authorizedExternalTools(), searchableSkills()]);
          return json(searchCapabilities(input, external, skills));
        }

        case "capability_call": {
          const input = CapabilityCallInput.parse(rawArgs);
          if (!isSkillRef(input.ref)) return callExternal(input.ref, input.args, extra.signal);
          // A skill ref runs the skill here, with the server's model — the
          // same thing skills_run does, gated by the same scope. An agent
          // that wants to run it with its own model has skills(op=get).
          ensureScope(ctx, "chat:run");
          const skill = (await searchableSkills()).find(({ node }) => skillMatchesRef(node, input.ref));
          if (!skill) return errorText(`unknown skill ref: ${input.ref}`);
          const { runSkill, SkillError } = await import("@/lib/skills/run");
          try {
            const out = await runSkill(ctx.storage, { skill_id: skill.node.id, input: input.args }, undefined, ctx.subjectUserId);
            return json({ ref: input.ref, executed: "server", ...out });
          } catch (err) {
            if (err instanceof SkillError) return errorText(err.message);
            throw err;
          }
        }

        default:
          return errorText(`unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof ScopeError) {
        return errorText(err.message);
      }
      if (err instanceof CapabilityAdminError || err instanceof CapabilityProvenanceError) {
        return errorText(`${err.code}: ${err.message}`);
      }
      if (err instanceof GrantError || err instanceof InvitationError) {
        // The reason matters here more than anywhere else: the caller is often
        // an agent that has to tell a person exactly what it lacks — or why an
        // invitation it just tried to send is being held.
        return errorText(`${err.code}: ${err.message}`);
      }
      if (err instanceof ForbiddenError) {
        // A missing verb is worth naming: the agent can tell its operator what
        // to grant instead of retrying blindly.
        return errorText(
          `forbidden: this principal lacks the "${err.verb}" permission in this workspace. An admin grants it with admin_write(op=grant); tags:create/tags:update come with nodes:write, tags:delete (merge/delete a tag) needs an agent token minted with admin:*.`,
        );
      }
      if (err instanceof NodeOutOfReachError) {
        // Deliberately indistinguishable from a node that does not exist. The
        // reach is not something an agent gets to probe the edges of.
        return errorText(`node not found: ${err.nodeId}`);
      }
      if (err instanceof NodeWriteError) {
        return errorText(`${err.code}: ${err.message}`);
      }
      if (err instanceof SubtaskError) {
        return errorText(err.message);
      }
      if (err instanceof GoalError) {
        return errorText(err.message);
      }
      if (err instanceof DatasetError) {
        return errorText(err.message);
      }
      if (err instanceof ConflictError) {
        // MCP has no HTTP status — encode 409 semantics in the message so
        // the agent knows this is retriable-after-rebase, not fatal.
        return errorText(
          `409 conflict: node ${err.nodeId} was modified by another session (updated_at is now ${err.currentUpdatedAt}, you expected ${err.expected}). Re-fetch with nodes(op=get), reapply your change on top, and retry with the new if_updated_at.`,
        );
      }
      if (err instanceof ViewConflictError) {
        return errorText(`409 conflict: view version is ${err.currentVersion}, expected ${err.expectedVersion}. Re-fetch with get_view, rebase, and retry.`);
      }
      if (err instanceof ViewNotFoundError) return errorText("view not found or not readable");
      // Taxonomy outcomes an agent can act on: a name already taken (or held
      // as an alias of another tag) is "reuse that tag or pick another name",
      // not a failure worth a panel entry.
      if (err instanceof TagConflictError) {
        return errorText(`409 conflict: ${err.message}. Call tags to find the existing tag and reuse its id, or choose a different name.`);
      }
      if (err instanceof TagNotFoundError) return errorText(`tag not found or inactive: ${err.tagId}`);
      if (err instanceof ViewForbiddenError) return errorText(`forbidden: ${err.message}`);
      if (err instanceof z.ZodError) {
        return errorText(`invalid arguments: ${err.message}`);
      }
      // Everything above is an outcome with a name — a scope the caller lacks,
      // a node out of reach, a stale `if_updated_at`. They are answers, and
      // reporting them would bury the panel under permission checks working
      // correctly. What falls through to here is the opposite: a throw nobody
      // anticipated, on its way to an agent as an opaque "tool error" string
      // that no human will ever read. This is the only place it exists.
      reportApiError({
        operation: `mcp.tool:${name}`,
        error: err,
        ...actorFields({
          actorType: ctx.tokenScope === "user" ? "user" : "agent_token",
          userId: ctx.subjectUserId,
          organizationId: ctx.storage.workspace.organization_id,
          workspaceId: ctx.workspaceId,
          tokenId: ctx.tokenId,
        }),
      });
      return errorText(
        `tool error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  return server;
}

// ---- helpers -------------------------------------------------------------

function mcpViewPrincipal(ctx: McpContext): ViewPrincipal {
  if (ctx.tokenScope === "user" && ctx.userId) {
    return {
      type: "user",
      id: ctx.userId,
      isAdmin: hasScope(ctx.scopes, "admin:*"),
      canWrite: hasScope(ctx.scopes, "nodes:write"),
    };
  }
  return {
    type: "agent",
    id: ctx.tokenId,
    isAdmin: hasScope(ctx.scopes, "admin:*"),
    canWrite: hasScope(ctx.scopes, "nodes:write"),
  };
}

/**
 * Half the tools historically took `id`, the other half `node_id` — each
 * mismatch cost an agent a failed round-trip. Both spellings are accepted
 * everywhere a single node is addressed; this maps the alias onto the
 * canonical key BEFORE strict validation (so real typos still error).
 */
const ID_CANONICAL: Record<string, "id" | "node_id"> = {
  "nodes:get": "id",
  "nodes_write:update": "id",
  "nodes_write:delete": "id",
  "nodes_write:toggle_checklist_item": "node_id",
  "nodes_write:append": "node_id",
  "nodes_write:replace_block": "node_id",
  "nodes_write:attach_file": "node_id",
};

function normalizeIdAlias(tool: string, raw: unknown): Record<string, unknown> {
  const args =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  // ask_rag answers questions — accept the spelling agents guess first.
  if (
    (tool === "ask_rag" || (tool === "nodes" && args.op === "search")) &&
    args.query === undefined &&
    typeof args.question === "string"
  ) {
    args.query = args.question;
    delete args.question;
  }
  // ask_nexo is the other way round: `question` is canonical, `query` the
  // spelling an agent brings over from ask_rag.
  if (tool === "ask_nexo" && args.question === undefined && typeof args.query === "string") {
    args.question = args.query;
    delete args.query;
  }
  // Keyed by `<tool>:<op>` now that the node tools are grouped: only the
  // branch that addresses a single node accepts the alias.
  const canonical = ID_CANONICAL[`${tool}:${typeof args.op === "string" ? args.op : ""}`];
  if (!canonical) return args;
  const alias = canonical === "id" ? "node_id" : "id";
  if (args[canonical] === undefined && typeof args[alias] === "string") {
    args[canonical] = args[alias];
    delete args[alias];
  }
  return args;
}

/** BFS over a directed adjacency map; returns the path from → to, or null. */
function findPath(
  adj: Map<string, string[]>,
  from: string,
  to: string,
): string[] | null {
  const prev = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === to) {
      const path = [to];
      let p = to;
      while (p !== from) {
        p = prev.get(p)!;
        path.unshift(p);
      }
      return path;
    }
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      queue.push(next);
    }
  }
  return null;
}

class ScopeError extends Error {}

let nativeToolNameSet: Set<string> | null = null;
/** Names of the native tools, for validating a skill's declared `tools`. */
function nativeToolNames(): Set<string> {
  nativeToolNameSet ??= new Set(TOOLS.map((tool) => tool.name));
  return nativeToolNameSet;
}

/**
 * The capability tools gate on the same verb the admin tools do. `admin` and
 * `admin_write` reach their check inside `listAccess`/`grantAccess`; these
 * have no such choke point, so the check is explicit and comes first.
 */
function requireAdminVerb(ctx: McpContext): void {
  if (!ctx.grant.verbs.includes("admin")) throw new ForbiddenError("admin");
}

function capabilityActor(ctx: McpContext): CapabilityAdminActor {
  return {
    workspaceId: ctx.workspaceId,
    userId: ctx.subjectUserId,
    tokenId: ctx.tokenId,
    tokenScope: ctx.tokenScope,
    agentId: ctx.agentId,
    agentLabel: ctx.agentLabel,
  };
}

function ensureScope(ctx: McpContext, scope: Scope) {
  if (!hasScope(ctx.scopes, scope)) {
    throw new ScopeError(`missing scope: ${scope}`);
  }
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function json(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

function errorText(t: string) {
  return { isError: true, content: [{ type: "text" as const, text: t }] };
}

/* -- Elicitation on privilege-widening admin ops ---------------------------- */

/**
 * What the human sees in the confirmation. A query reach is printed as its
 * JSON: it is the exact object that will be stored, and the admin can
 * `admin(op=preview)` it first if the shape is not self-explanatory.
 */
function describeReach(reach: Reach): string {
  return reach.type === "all" ? "all nodes" : `query ${JSON.stringify(reach.query)}`;
}

/** How long the human gets to answer before the op is abandoned. */
const ELICITATION_TIMEOUT_MS = 60_000;

type WideningConfirmation =
  | { ok: true; elicitation: "confirmed" | "unsupported_by_client" }
  | { ok: false; error: string };

/**
 * `admin_write(op=grant|invite)` is the only tool that makes a principal more
 * powerful than it was, and an agent holding the admin verb could be talked
 * into calling it. So, when the connected client can put a question to its
 * user (MCP elicitation, client capability `elicitation`), the grant is
 * spelled out and confirmed by a person before anything is written. The spec
 * only allows an elicitation while a client request is being served, which
 * is exactly where this runs.
 *
 * A client without the capability proceeds as before — the admin verb and the
 * audit trail remain the safeguard — and the receipt says so
 * (`elicitation: "unsupported_by_client"`), so a reviewer can tell the two
 * apart after the fact.
 *
 * Declining, cancelling, answering anything but `confirm: true`, not
 * answering in time, or a client error all abort the op with a plain reason;
 * nothing is written on any of those paths.
 */
async function confirmPrivilegeWidening(
  server: Server,
  ctx: McpContext,
  input: { verbs: readonly Verb[]; reach: Reach; question: string },
): Promise<WideningConfirmation> {
  // A grant the caller could never make is refused by grantAccess /
  // inviteToWorkspace with the proper reason; do not make a person confirm
  // something that is about to be rejected anyway.
  if (!ctx.grant.verbs.includes("admin")) return { ok: true, elicitation: "unsupported_by_client" };
  if (!canGrant(ctx.grant, input.verbs, input.reach).ok) return { ok: true, elicitation: "unsupported_by_client" };

  const capability = server.getClientCapabilities()?.elicitation;
  if (!capability) return { ok: true, elicitation: "unsupported_by_client" };
  // Spec 2025-11-25: `form` and `url` are declared explicitly; an empty
  // object (2025-06-18 clients) means form. A url-only client cannot show a
  // form, so it is treated like one with no capability at all.
  const declaresForm = capability.form !== undefined;
  const supportsForm = declaresForm || capability.url === undefined;
  if (!supportsForm) return { ok: true, elicitation: "unsupported_by_client" };

  const params = {
    mode: "form" as const,
    message: input.question,
    requestedSchema: {
      type: "object" as const,
      properties: {
        confirm: {
          type: "boolean" as const,
          title: "Confirm",
          description: "true to go ahead, false to abort",
        },
      },
      required: ["confirm"],
    },
  };
  let result: ElicitResult;
  try {
    // `Server.elicitInput` insists on the explicit `form` declaration; the
    // legacy empty object goes through the same wire request by hand.
    result = declaresForm
      ? await server.elicitInput(params, { timeout: ELICITATION_TIMEOUT_MS })
      : await server.request(
          { method: "elicitation/create", params },
          ElicitResultSchema,
          { timeout: ELICITATION_TIMEOUT_MS },
        );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `aborted: the client did not answer the confirmation (${reason}); nothing was granted` };
  }
  if (result.action !== "accept") {
    return { ok: false, error: `aborted: the confirmation was ${result.action === "decline" ? "declined" : "cancelled"}; nothing was granted` };
  }
  if (result.content?.confirm !== true) {
    return { ok: false, error: "aborted: the confirmation was not answered with confirm=true; nothing was granted" };
  }
  return { ok: true, elicitation: "confirmed" };
}

/**
 * Recent changes for `list_changes`. Supabase-backed workspaces read the
 * durable `activity` table (survives restarts, sees every writer); demo
 * workspaces fall back to the in-memory ring buffer.
 */
async function listWorkspaceChanges(
  ctx: McpContext,
  input: z.infer<typeof ListChangesInput>,
) {
  return listChangePageForStorage(ctx.storage, ctx.workspaceRef, {
    limit: input.limit,
    since: input.since,
    nodeId: input.node_id,
    actorKinds: input.actor,
    kinds: input.action,
    nodeKinds: input.kind,
    tagId: input.tag_id,
    source: input.source,
    from: input.from,
    to: input.to,
    cursor: input.cursor,
  });
}

function appendMcpChangeAudit(
  ctx: McpContext,
  action: string,
  targetId: string,
  input?: unknown,
  output?: unknown,
): void {
  if (ctx.storage.backend !== "supabase") return;
  void appendAudit({
    workspaceId: ctx.workspaceId,
    actorType: "agent",
    actorId: ctx.userId ?? null,
    agentTokenId: ctx.tokenId,
    action,
    targetType: action.startsWith("edge.") ? "edge" : "node",
    targetId,
    input,
    output,
  });
}

interface AccessibleWorkspace {
  id: string;
  slug: string;
  name: string;
  role: string | null;
}

async function listAccessibleWorkspaces(
  ctx: McpContext,
): Promise<AccessibleWorkspace[]> {
  // Workspace-scoped tokens trivially list their bound workspace. We use
  // the storage instance already on the ctx to avoid an extra round-trip.
  if (ctx.tokenScope === "workspace" || !ctx.userId) {
    return [
      {
        id: ctx.storage.workspace.id,
        slug: ctx.storage.workspace.slug,
        name: ctx.storage.workspace.name,
        role: null,
      },
    ];
  }

  // Agent identities enumerate only explicit grants. Legacy user tokens
  // without an agent id keep membership-based behavior.
  const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
  const admin = getSupabaseAdmin();
  if (ctx.agentId) {
    const { data, error } = await admin
      .from("agent_workspace_access")
      .select("role, workspaces:workspace_id (id, slug, name)")
      .eq("agent_id", ctx.agentId)
      .is("revoked_at", null);
    if (error || !data) return [];
    return (data as Array<{
      role: string | null;
      workspaces: { id: string; slug: string; name: string } | null;
    }>).flatMap((row) => row.workspaces ? [{
      id: row.workspaces.id,
      slug: row.workspaces.slug,
      name: row.workspaces.name,
      role: row.role,
    }] : []).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  const { data, error } = await admin
    .from("memberships")
    .select("role, workspaces:workspace_id (id, slug, name)")
    .eq("user_id", ctx.userId);
  if (error || !data) return [];
  const rows: AccessibleWorkspace[] = [];
  for (const row of data as Array<{
    role: string | null;
    workspaces: { id: string; slug: string; name: string } | null;
  }>) {
    if (!row.workspaces) continue;
    rows.push({
      id: row.workspaces.id,
      slug: row.workspaces.slug,
      name: row.workspaces.name,
      role: row.role ?? null,
    });
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug));
  return rows;
}

// ---- Resources ----------------------------------------------------------

function workspaceUri(slug: string, kind: "tree" | "agents-md"): string {
  return `context://workspace/${slug}/${kind}`;
}

function registerResources(server: Server, ctx: McpContext) {
  const resources: Resource[] = [
    {
      uri: workspaceUri(ctx.workspaceRef, "tree"),
      name: `${ctx.workspaceRef} — semantic hierarchy + tags`,
      description:
        "Compact JSON hierarchy and tag assignments for every semantic node. The URI stays /tree for protocol compatibility; `folder` and `category` are not node fields.",
      mimeType: "application/json",
    },
    {
      uri: workspaceUri(ctx.workspaceRef, "agents-md"),
      name: `${ctx.workspaceRef} — AGENTS.md`,
      description:
        "Generated AGENTS.md derived from skill nodes in this workspace. Use as the system-level rules pack for downstream agents.",
      mimeType: "text/markdown",
    },
  ];

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    try {
      if (uri === workspaceUri(ctx.workspaceRef, "tree")) {
        ensureScope(ctx, "nodes:read");
        const nodes = await ctx.storage.listNodes();
        const tree = nodes.map((n) => ({
          id: n.id,
          parent_id: n.parent_id,
          kind: n.kind,
          tags: n.tags,
          slug: n.slug,
          title: n.title,
          status: n.status,
          updated_at: n.updated_at,
        }));
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(tree, null, 2),
            },
          ],
        };
      }
      if (uri === workspaceUri(ctx.workspaceRef, "agents-md")) {
        ensureScope(ctx, "nodes:read");
        const nodes = await ctx.storage.listNodes();
        const skills = extractSkills(nodes);
        const body = generate("agents-md", skills, {
          workspaceName: ctx.storage.workspace.name,
        });
        return {
          contents: [{ uri, mimeType: "text/markdown", text: body }],
        };
      }
      throw new Error(`unknown resource: ${uri}`);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  });
}

// ---- Prompts ------------------------------------------------------------

function registerPrompts(server: Server, ctx: McpContext) {
  const prompts: Prompt[] = [
    {
      name: "summarize_node",
      description:
        "Summarize a node into a 3-sentence brief, calling out decisions and open questions.",
      arguments: [
        { name: "node_id", description: "Target node id", required: true },
      ],
    },
    {
      name: "daily_brief",
      description:
        "Generate a daily standup-style brief grouped by [tasks shipped, decisions made, blockers].",
      arguments: [
        {
          name: "since",
          description: "ISO date (inclusive). Defaults to 24h ago.",
          required: false,
        },
      ],
    },
    {
      name: "meeting_to_decisions",
      description:
        "Read the meeting node and propose `decision` + `task` nodes via nodes_write(op=create). Idempotency-Key is recommended.",
      arguments: [
        { name: "meeting_id", description: "Meeting node id", required: true },
      ],
    },
  ];

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    switch (name) {
      case "summarize_node":
        return {
          description: "Summarize a Bcontext node.",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Summarize Bcontext node \`${args.node_id ?? ""}\` into 3 sentences. Fetch it via nodes(op=get) first; emit Markdown.`,
              },
            },
          ],
        };
      case "daily_brief":
        return {
          description: "Daily brief from workspace activity.",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Using brief, list_changes, nodes(op=search) and nodes(op=get), produce a daily brief for workspace \`${ctx.workspaceRef}\` since \`${args.since ?? "24h ago"}\`. Group: shipped, decisions, blockers, and newly unblocked tasks (nodes({ op: 'list', kind: 'task', unblocked: true })). Markdown only, under 200 words.`,
              },
            },
          ],
        };
      case "meeting_to_decisions":
        return {
          description: "Extract decisions + tasks from a meeting note.",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Read meeting node \`${args.meeting_id ?? ""}\` via nodes(op=get). For each commitment, emit a nodes_write(op=create) call (kind=decision or task). Use a stable Idempotency-Key per commitment so retries are safe.`,
              },
            },
          ],
        };
      default:
        throw new Error(`unknown prompt: ${name}`);
    }
  });
}
