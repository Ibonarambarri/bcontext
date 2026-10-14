/**
 * Connector runtime — wraps the four-method Connector interface with:
 *
 *   - secret resolution (`secret_ref` → plaintext)
 *   - job queue persistence (`connector_jobs` rows for full_sync /
 *     webhook / push kinds)
 *   - idempotent node upserts by (source, external_id) via the partial
 *     unique index added in migration 0011
 *   - retry / DLQ on transient failures (mirrors webhook_deliveries
 *     semantics so both drains share the same pg-boss worker patterns)
 *
 * Routes call `enqueueFullSync` / `runJob` and never touch connector state
 * directly; webhook routes run the connector inline and upsert the result.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getStorageById, type Storage } from "@/lib/storage";
import { log } from "@bcontext-dev/contract/log";
import { getConnector } from "./registry";
import { getInstall, getInstallById, updateInstall } from "./installs";
import { getSecret } from "./secrets";
import type {
  ConnectorContext,
  ConnectorId,
  ContextNodeInput,
  WebhookEnvelope,
} from "@bcontext-dev/contract/connectors/types";

export type JobKind = "full_sync" | "webhook" | "push";
export type JobStatus = "queued" | "running" | "done" | "failed" | "dead";

interface JobRow {
  id: string;
  workspace_id: string;
  install_id: string | null;
  connector_id: ConnectorId;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
}

const BACKOFF_SCHEDULE_SEC = [30, 120, 600, 3600, 86400];

function backoffSeconds(attempts: number): number {
  const idx = Math.min(attempts, BACKOFF_SCHEDULE_SEC.length - 1);
  return BACKOFF_SCHEDULE_SEC[idx] ?? 60;
}

async function buildContext(install: { id: string; workspace_id: string; config: Record<string, unknown>; secret_ref: string | null }): Promise<ConnectorContext> {
  const secret = await getSecret(install.secret_ref);
  return {
    workspaceId: install.workspace_id,
    installId: install.id,
    config: install.config,
    secret,
  };
}

// -- Enqueue ----------------------------------------------------------------

export async function enqueueFullSync(input: {
  workspaceId: string;
  connectorId: ConnectorId;
  installId: string;
  cursor?: string | null;
}): Promise<string> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("connector_jobs")
    .insert({
      workspace_id: input.workspaceId,
      install_id: input.installId,
      connector_id: input.connectorId,
      kind: "full_sync" as JobKind,
      payload: { cursor: input.cursor ?? null },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`enqueueFullSync: ${error?.message}`);
  return data.id as string;
}

// -- Run --------------------------------------------------------------------

/**
 * Execute a job. Caller is responsible for picking the next queued row.
 * Returns the new status so the caller can decide whether to re-queue.
 */
export async function runJob(jobId: string): Promise<{ status: JobStatus; error?: string }> {
  const sb = getSupabaseAdmin();
  const { data: jobRow } = await sb
    .from("connector_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (!jobRow) return { status: "failed", error: "job_not_found" };
  const job = jobRow as JobRow;

  await sb
    .from("connector_jobs")
    .update({
      status: "running" as JobStatus,
      started_at: new Date().toISOString(),
      attempts: job.attempts + 1,
    })
    .eq("id", jobId);

  const connector = getConnector(job.connector_id);
  const install = job.install_id ? await getInstallById(job.install_id) : null;
  if (!install) {
    return finalize(job, "dead", "install_missing");
  }
  const ctx = await buildContext(install);

  try {
    if (job.kind === "full_sync") {
      const cursor = (job.payload.cursor as string | null | undefined) ?? null;
      const out = await connector.fullSync(ctx, cursor);
      await upsertConnectorNodes(install.workspace_id, out.nodes);
      await updateInstall(install.id, {
        last_sync_at: new Date().toISOString(),
        last_error: null,
        status: "active",
      });
      log.info("connector.full_sync.done", {
        workspace_id: install.workspace_id,
        connector: job.connector_id,
        processed: out.processed,
      });
      if (out.hasMore) {
        await enqueueFullSync({
          workspaceId: install.workspace_id,
          connectorId: job.connector_id,
          installId: install.id,
          cursor: out.cursor ?? null,
        });
      }
      return finalize(job, "done");
    }

    if (job.kind === "webhook") {
      const envelope = job.payload.envelope as WebhookEnvelope;
      const outcome = await connector.handleWebhook(ctx, envelope);
      await upsertConnectorNodes(install.workspace_id, outcome.nodes);
      return finalize(job, "done");
    }

    return finalize(job, "done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("connector.job.failed", {
      job_id: jobId,
      connector: job.connector_id,
      attempt: job.attempts + 1,
      error: message,
    });
    const dead = job.attempts + 1 >= job.max_attempts;
    if (dead) {
      await updateInstall(install.id, {
        status: "errored",
        last_error: message,
      });
      return finalize(job, "dead", message);
    }
    const next = new Date(Date.now() + backoffSeconds(job.attempts) * 1000);
    await sb
      .from("connector_jobs")
      .update({
        status: "failed" as JobStatus,
        last_error: message,
        next_attempt_at: next.toISOString(),
      })
      .eq("id", jobId);
    return { status: "failed", error: message };
  }
}

async function finalize(
  job: JobRow,
  status: "done" | "dead",
  error?: string,
): Promise<{ status: JobStatus; error?: string }> {
  const sb = getSupabaseAdmin();
  await sb
    .from("connector_jobs")
    .update({
      status,
      completed_at: new Date().toISOString(),
      last_error: error ?? null,
    })
    .eq("id", job.id);
  return { status, error };
}

// -- Idempotent upsert ------------------------------------------------------

/**
 * Insert or update nodes keyed by (workspace_id, data.source, data.external_id).
 * Uses the partial unique index `nodes_source_external_id_idx` from 0011.
 *
 * The Postgres upsert path requires a target inferred from the unique
 * index. We use a try-insert / on-conflict-update sequence via a single
 * Postgres-side `insert ... on conflict do update`. Postgrest's onConflict
 * needs a column list — since our index is over an expression we go
 * through a stored RPC instead.
 *
 * Simpler dialect that works without an RPC: select by source+external_id
 * first; insert or update accordingly. Fine at the volume connectors
 * generate (no thundering herd; jobs serialise).
 */
export async function upsertConnectorNodes(
  workspaceId: string,
  inputs: ContextNodeInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  const sb = getSupabaseAdmin();
  const storage = await getStorageById(workspaceId);
  if (!storage) throw new Error("connector workspace not found");
  for (const node of inputs) {
    const { data: existing } = await sb
      .from("nodes")
      .select("id")
      .eq("workspace_id", workspaceId)
      .filter("data->>source", "eq", node.source)
      .filter("data->>external_id", "eq", node.external_id)
      .maybeSingle();

    if (existing) {
      const current = await storage.getNode(existing.id as string);
      if (!current) throw new Error("connector node disappeared during upsert");
      const data = {
        ...(current.data ?? {}),
        ...(node.data ?? {}),
        source: node.source,
        external_id: node.external_id,
      };
      const tagIds = await resolveConnectorTagIds(storage, node.tags);
      await storage.updateNode(current.id, {
        title: node.title,
        content_md: node.content_md ?? "",
        status: connectorStatus(node.status),
        priority: connectorPriority(node.priority),
        data,
        ...(tagIds === undefined ? {} : { tag_ids: tagIds }),
      });
    } else {
      const data = {
        ...(node.data ?? {}),
        source: node.source,
        external_id: node.external_id,
      };
      const tagIds = await resolveConnectorTagIds(storage, node.tags);
      await storage.createNode({
        parent_id: node.parent_id ?? null,
        kind: node.kind,
        title: node.title,
        content_md: node.content_md ?? "",
        status: connectorStatus(node.status),
        priority: connectorPriority(node.priority),
        data,
        tag_ids: tagIds,
      });
    }
  }
}

async function resolveConnectorTagIds(
  storage: Storage,
  names: string[] | undefined,
): Promise<string[] | undefined> {
  if (names === undefined) return undefined;
  const resolved = await storage.resolveTagIds(names);
  return Array.from(new Set(resolved.values()));
}

function connectorStatus(value: string | null | undefined) {
  return ["backlog", "todo", "in_progress", "review", "blocked", "done", "archived"].includes(value ?? "")
    ? value as "backlog" | "todo" | "in_progress" | "review" | "blocked" | "done"
    : null;
}

function connectorPriority(value: string | null | undefined) {
  return ["low", "med", "high", "urgent"].includes(value ?? "")
    ? value as "low" | "med" | "high" | "urgent"
    : null;
}

// -- Convenience for routes -------------------------------------------------

export async function runFullSyncSync(
  workspaceId: string,
  connectorId: ConnectorId,
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const install = await getInstall(workspaceId, connectorId);
  if (!install) return { ok: false, error: "not_installed" };
  if (install.status !== "active") return { ok: false, error: `install_${install.status}` };
  const jobId = await enqueueFullSync({
    workspaceId,
    connectorId,
    installId: install.id,
    cursor: null,
  });
  // Run inline. In production a separate worker should pull the queue;
  // running inline keeps the install-and-backfill flow snappy.
  const result = await runJob(jobId);
  return { ok: result.status === "done", jobId, error: result.error };
}
