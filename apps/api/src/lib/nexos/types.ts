/**
 * Server-side shapes for Nexos that never cross the wire, next to the
 * contract ones they build on (`@bcontext-dev/contract/nexos`).
 *
 * Callers: `./store`, `./lifecycle`, the runtime (`./runtime/*`) and the
 * triggers (`./triggers/*`). Must not break: `NexoTarget` is how every store
 * call picks its backend — the in-memory one for demo workspaces and tests,
 * Postgres otherwise — so a caller that has a `Storage` uses `nexoTarget()`
 * rather than guessing.
 */
import type { StorageBackend } from "@/lib/storage";
import type {
  NexoAutonomy,
  NexoBrainTools,
  NexoEscalation,
  NexoHeartbeat,
  NexoInboxKind,
  NexoInboxStatus,
  NexoQuestionnaire,
  NexoRunStatus,
  NexoRunStep,
  NexoRunTrigger,
} from "@bcontext-dev/contract/nexos";

export type {
  Nexo,
  NexoBinding,
  NexoInboxItem,
  NexoListItem,
  NexoRun,
  NexoSession,
  NexoTools,
  NexoToolGrant,
  OrgAiKey,
  OrgAiKeyProvider,
} from "@bcontext-dev/contract/nexos";

/** Which workspace, on which backend. Every per-workspace store call takes one. */
export interface NexoTarget {
  workspaceId: string;
  backend: StorageBackend;
}

/** Fields the lifecycle writes when it creates a Nexo row (the agent already exists). */
export interface NewNexoRow {
  agent_id: string;
  slug: string;
  name: string;
  description: string;
  is_general: boolean;
  template: string;
  questionnaire: Partial<NexoQuestionnaire>;
  prompt_md: string;
  model: string | null;
  autonomy: NexoAutonomy;
  brain_tools: NexoBrainTools;
  heartbeat: NexoHeartbeat;
  escalation: NexoEscalation;
  monthly_budget_credits: number | null;
  created_by: string | null;
}

/** What `updateNexoRow` may change. Lifecycle-owned fields (agent_id, is_general, slug) are absent on purpose. */
export interface NexoRowPatch {
  name?: string;
  description?: string;
  template?: string;
  questionnaire?: Partial<NexoQuestionnaire>;
  prompt_md?: string;
  model?: string | null;
  autonomy?: NexoAutonomy;
  brain_tools?: NexoBrainTools;
  heartbeat?: NexoHeartbeat;
  escalation?: NexoEscalation;
  monthly_budget_credits?: number | null;
  status?: "active" | "paused";
  last_run_at?: string | null;
  next_heartbeat_at?: string | null;
}

export interface CreateRunInput {
  nexoId: string;
  trigger: NexoRunTrigger;
  input?: Record<string, unknown>;
}

export interface FinishRunInput {
  status: Exclude<NexoRunStatus, "running">;
  output_md?: string | null;
  steps?: NexoRunStep[];
  usage?: Record<string, unknown>;
  error?: string | null;
}

export interface CreateInboxItemInput {
  nexoId: string;
  runId?: string | null;
  kind: NexoInboxKind;
  title: string;
  body_md?: string;
  payload?: Record<string, unknown>;
}

export interface ResolveInboxItemInput {
  status: Exclude<NexoInboxStatus, "open">;
  resolvedBy: string | null;
  /** Merged over the stored payload (e.g. the edited `draft_text`, the sent message ts). */
  payload?: Record<string, unknown>;
}

/** One compact inbound message inside a window. */
export interface NexoWindowEvent {
  ts: string;
  author: string;
  text: string;
  [key: string]: unknown;
}

export type NexoWindowState = "collecting" | "flushing" | "flushed";

export interface NexoWindow {
  id: string;
  workspace_id: string;
  nexo_id: string;
  binding_id: string | null;
  source_key: string;
  events: NexoWindowEvent[];
  message_count: number;
  first_at: string;
  last_at: string;
  flush_after: string;
  state: NexoWindowState;
  claimed_at: string | null;
  flushed_at: string | null;
  created_at: string;
}

export interface AppendWindowEventInput {
  nexoId: string;
  bindingId: string | null;
  /** e.g. `slack:<team>:<channel>:<thread_ts>`. */
  sourceKey: string;
  event: NexoWindowEvent;
  /** Silence before a window flushes. Default 600 (10 min). */
  quietSeconds?: number;
  /** Message cap that flushes immediately. Default 40. */
  maxMessages?: number;
  /** Span cap (first → last message) that flushes immediately. Default 21600 (6 h). */
  maxSpanSeconds?: number;
}

/** Defaults the window RPC also applies; exported so triggers and tests agree. */
export const WINDOW_DEFAULTS = {
  quietSeconds: 600,
  maxMessages: 40,
  maxSpanSeconds: 6 * 60 * 60,
  /** A window `flushing` longer than this is reclaimed (its worker died). */
  staleSeconds: 900,
  /** Longest single event text kept in a window. */
  maxEventText: 4_000,
} as const;
