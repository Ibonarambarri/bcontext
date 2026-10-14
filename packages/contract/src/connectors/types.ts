/**
 * Connector framework types.
 *
 * Every connector implements the same 4-method interface. The runtime
 * (`runtime.ts`) calls these in response to install / webhook / sync
 * triggers and never reaches inside a connector's state.
 *
 *   authorize       — install/uninstall lifecycle. Returns the secret_ref
 *                     to store in connector_installs.
 *   fullSync        — one-shot crawl after install. Backfills the
 *                     workspace's nodes from the external source.
 *   handleWebhook   — verify + map a webhook payload to a node upsert.
 *   toContextNode   — pure mapper: external entity → ContextNodeInput.
 *                     The runtime upserts via (source, external_id).
 *
 * Connectors must be pure functions of their inputs + the secret. No
 * global state. The runtime injects a per-request `ConnectorContext`
 * that exposes the workspace, the secret, and a logger.
 */
import type { NodeKind } from "../types.js";

/**
 * Connectors that ship their own auth + transport inside bcontext-api.
 * Everything else is a Nango-backed connector whose id is the Nango
 * integration unique_key (see `./catalog.ts` and `src/lib/connectors/nango`).
 */
export type NativeConnectorId = "github" | "slack" | "linear" | "notion" | "meeting-bot";
export type ConnectorId = NativeConnectorId | (string & {});

export interface ConnectorContext {
  /** Workspace this connector install belongs to. */
  workspaceId: string;
  /** Stable connector install row id. */
  installId: string;
  /** Free-form per-install config (channel allowlist, repos, branch…). */
  config: Record<string, unknown>;
  /** Resolved secret (already dereferenced from secret_ref). */
  secret: string | null;
}

/**
 * The mapped output of `toContextNode` — what the runtime upserts via
 * the (source, external_id) idempotency key. Mirrors the shape accepted
 * by `POST /api/agents/write`.
 */
export interface ContextNodeInput {
  /** External system this came from. Stored in `nodes.data.source`. */
  source: ConnectorId;
  /** Stable id in the external system. Stored in `nodes.data.external_id`. */
  external_id: string;
  /** Semantic target kind. */
  kind: NodeKind;
  title: string;
  /** Markdown content; the importer round-trips this through TipTap. */
  content_md?: string;
  /** Optional real hierarchy parent (a semantic node in this workspace). */
  parent_id?: string | null;
  /** Existing workspace tag names/slugs to resolve and assign. */
  tags?: string[];
  /** Status/priority where applicable (tasks). */
  status?: string | null;
  priority?: string | null;
  /** Arbitrary metadata; merged on top of {source, external_id}. */
  data?: Record<string, unknown>;
}

export interface WebhookEnvelope {
  /** Raw body, used for signature verification before JSON.parse. */
  rawBody: string;
  /** All headers, lowercased keys. */
  headers: Record<string, string>;
}

export interface WebhookOutcome {
  /** Upserts the runtime should apply via the storage layer. */
  nodes: ContextNodeInput[];
  /** Optional log line for the audit trail. */
  audit?: string;
}

export interface SyncResult {
  /** Total entities processed in this fullSync run. */
  processed: number;
  /** Per-kind histogram for the audit log. */
  byKind: Record<string, number>;
  /** Whether the connector wants the runtime to schedule a follow-up. */
  hasMore?: boolean;
  /** Optional cursor for the next page. Echoed back to fullSync. */
  cursor?: string | null;
}

export interface Connector {
  id: ConnectorId;

  /**
   * Begin / complete / revoke an install. Returns the secret_ref to
   * persist on `connector_installs.secret_ref`. The runtime ensures the
   * install row is in `pending` status when this is called for `start`,
   * and flips to `active` on `complete`.
   */
  authorize(
    ctx: ConnectorContext,
    phase: "start" | "complete" | "revoke",
    payload?: Record<string, unknown>,
  ): Promise<{ secretRef?: string; redirectUrl?: string }>;

  /**
   * Backfill from the external system. Called once on install completion
   * and on manual resync from the UI. Workers cron-poll for restarts.
   */
  fullSync(
    ctx: ConnectorContext,
    cursor?: string | null,
  ): Promise<SyncResult & { nodes: ContextNodeInput[] }>;

  /**
   * Map a single inbound webhook to node upserts. Must verify the
   * signature before returning anything (throw on invalid signature).
   */
  handleWebhook(
    ctx: ConnectorContext,
    envelope: WebhookEnvelope,
  ): Promise<WebhookOutcome>;

  /**
   * Pure mapper for a single external entity → ContextNodeInput. Used by
   * fullSync and webhook handlers. Exposed so tests can assert mapping
   * shape without setting up the runtime.
   */
  toContextNode(
    ctx: ConnectorContext,
    entity: Record<string, unknown>,
  ): ContextNodeInput | null;
}

export class ConnectorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAuthError";
  }
}

export class ConnectorSignatureError extends Error {
  constructor(message = "invalid signature") {
    super(message);
    this.name = "ConnectorSignatureError";
  }
}
