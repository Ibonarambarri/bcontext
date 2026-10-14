/**
 * Generic Nango-backed connector.
 *
 * One implementation of the four-method `Connector` interface, built from a
 * small per-provider adapter (`./adapters/<id>.ts`). Nango owns auth and the HTTP
 * transport; we own the cursor, the batch extraction and NEXO's triage.
 *
 *   authorize('start')   → Connect session (token + link) for this workspace;
 *                          payload.oauth_app = the customer's own client id/secret
 *                          (hybrid OAuth, src/lib/nango/own-app.ts)
 *   authorize('complete')→ called by /api/webhooks/nango with { connection_id }
 *   authorize('revoke')  → delete the Nango connection (and the own-app integration)
 *   fullSync(ctx, cursor)→ fetch what changed since the last run, hand Slack
 *                          signals of Nexo-owned channels to that Nexo's
 *                          window, fold the rest into few candidates, let
 *                          NEXO triage them
 *   handleWebhook        → not used (Nango connectors poll on cadence)
 *   toContextNode        → raw signals never become nodes on their own
 *
 * Install config keys this connector reads/writes:
 *   provider: "nango"                 marks the install as Nango-backed
 *   nango_integration_key             Nango unique_key the install talks to
 *                                     (shared `<key>` or own `<key>--<ws>`)
 *   oauth_app                         "shared" | "own" — whose OAuth app
 *   nango_connection_id               set by the auth webhook
 *   nango_connection_config           subdomain etc., copied from Nango
 *   last_cursor                       ISO instant of the last successful run
 *   last_run_stats                    { at, signals, candidates, accepted, conflicts }
 *   ingest_guidance / cadence / next_run_at   (shared with every connector)
 */
import { registerConnector } from "../registry";
import { getInstallById, updateInstall } from "../installs";
import type {
  Connector,
  ConnectorContext,
  ContextNodeInput,
  SyncResult,
  WebhookOutcome,
} from "@bcontext-dev/contract/connectors/types";
import { ConnectorAuthError } from "@bcontext-dev/contract/connectors/types";
import { log } from "@bcontext-dev/contract/log";
import { nangoClient, NangoError, type NangoClient } from "@/lib/nango/client";
import {
  deleteOwnOAuthApp,
  installIntegrationKey,
  installOAuthAppKind,
  upsertOwnOAuthApp,
  withIntegrationKey,
} from "@/lib/nango/own-app";
import { setupFromCredentials } from "@/lib/nango/setup";
import { catalogEntry } from "../catalog";
import {
  batchExternalId,
  extractBatch,
  type IngestSignal,
} from "@/lib/ingest/batch-extract";
import { ExtractCandidateError } from "@/lib/ingest/extract";
import { proposeCandidate } from "@/lib/ingest/candidates";
import { triageCandidate } from "@/lib/nexo/triage";
import { routeNangoSignalsToNexos } from "@/lib/nexos/triggers/nango-inbound";
import type { NangoAdapter } from "./adapters/shared";

/** First run looks back this far; later runs use `last_cursor`. */
export const FIRST_RUN_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** Soft cap on signals per run, per adapter. */
export const SIGNALS_PER_RUN = 80;

/**
 * Thrown by `authorize('start')` for an OAuth provider when Bcontext has no
 * shared OAuth app and the workspace did not bring its own: the install
 * route answers 409 with the entry's `oauth_setup` so the UI shows the form.
 */
export class NangoOAuthAppRequiredError extends ConnectorAuthError {
  constructor(public readonly connectorKey: string) {
    super(`${connectorKey}: no shared OAuth app is configured; connect with your own OAuth app`);
    this.name = "NangoOAuthAppRequiredError";
  }
}

export interface OwnOAuthAppPayload {
  client_id: string;
  client_secret: string;
  scopes?: string[];
}

export interface NangoInstallConfig {
  provider?: string;
  nango_integration_key?: string;
  oauth_app?: "shared" | "own";
  nango_connection_id?: string;
  nango_connection_config?: Record<string, unknown>;
  last_cursor?: string;
  ingest_guidance?: string;
}

export function isNangoInstall(config: Record<string, unknown>): boolean {
  return config.provider === "nango";
}

export function sinceFor(config: Record<string, unknown>, cursor: string | null, now = new Date()): Date {
  const raw = cursor ?? (typeof config.last_cursor === "string" ? config.last_cursor : null);
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
}

export interface RunSummary {
  signals: number;
  candidates: number;
  accepted: number;
  conflicts: number;
  skipped: number;
}

/**
 * The daily loop, without the connector plumbing so it can be unit-tested:
 * signals → batch candidates → propose → triage. Never throws on the AI
 * side; a missing gateway key means "fetched, nothing extracted".
 */
export async function ingestSignals(input: {
  workspaceId: string;
  connectorId: string;
  installId: string;
  sourceHint: string;
  guidance: string | null;
  signals: IngestSignal[];
}): Promise<RunSummary> {
  const summary: RunSummary = { signals: input.signals.length, candidates: 0, accepted: 0, conflicts: 0, skipped: 0 };
  if (input.signals.length === 0) return summary;

  let batch;
  try {
    batch = await extractBatch({
      workspaceId: input.workspaceId,
      sourceHint: input.sourceHint,
      guidance: input.guidance,
      signals: input.signals,
    });
  } catch (err) {
    if (err instanceof ExtractCandidateError && err.code === "no_gateway_key") {
      log.warn("connector.nango.no_gateway_key", { workspace_id: input.workspaceId, connector: input.connectorId });
      return summary;
    }
    throw err;
  }
  summary.skipped = batch.skipped;

  const byId = new Map(input.signals.map((s) => [s.external_id, s]));
  for (const c of batch.candidates) {
    const evidence = c.evidence.map((e) => {
      const s = byId.get(e.external_id);
      return { source: input.connectorId, external_id: e.external_id, url: s?.url, excerpt: e.excerpt, at: s?.at };
    });
    const candidate = await proposeCandidate({
      workspaceId: input.workspaceId,
      source: input.connectorId,
      externalId: batchExternalId(c.kind, c.evidence),
      kind: c.kind,
      title: c.title,
      contentMd: c.contentMd,
      confidence: c.confidence,
      provenance: {
        connector: input.connectorId,
        install_id: input.installId,
        extractor: "batch",
        model: batch.model,
        evidence,
      },
    });
    summary.candidates += 1;
    const outcome = await triageCandidate(candidate, { evidence });
    if (outcome.kind === "accepted") summary.accepted += 1;
    if (outcome.kind === "conflict") summary.conflicts += 1;
  }
  return summary;
}

function readOwnAppPayload(payload: Record<string, unknown> | undefined): OwnOAuthAppPayload | null {
  const raw = payload?.oauth_app;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.client_id !== "string" || typeof o.client_secret !== "string") return null;
  if (!o.client_id.trim() || !o.client_secret.trim()) return null;
  const scopes = Array.isArray(o.scopes) ? o.scopes.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : undefined;
  return { client_id: o.client_id.trim(), client_secret: o.client_secret, ...(scopes ? { scopes } : {}) };
}

export function nangoConnector(adapter: NangoAdapter, deps: { client?: () => NangoClient } = {}): Connector {
  const client = deps.client ?? nangoClient;

  const connector: Connector = {
    id: adapter.id,

    async authorize(ctx, phase, payload) {
      if (phase === "start") {
        const entry = catalogEntry(adapter.id);
        const isOAuth = entry?.auth === "oauth2";
        const own = readOwnAppPayload(payload);
        let integrationKey = adapter.id;
        let oauthApp: "shared" | "own" = "shared";
        try {
          if (isOAuth && own) {
            integrationKey = await upsertOwnOAuthApp(client(), {
              connectorKey: adapter.id,
              nangoProvider: adapter.provider,
              displayName: entry?.name ?? adapter.id,
              workspaceId: ctx.workspaceId,
              clientId: own.client_id,
              clientSecret: own.client_secret,
              scopes: own.scopes ?? null,
            });
            oauthApp = "own";
          } else if (isOAuth) {
            // Hybrid: Bcontext's shared app when the owner registered one;
            // otherwise the workspace must bring its own (409 upstream).
            const shared = await client().getIntegration(adapter.id);
            const ready = shared !== null && setupFromCredentials(shared.credentials?.clientId) === "ready";
            if (!ready) throw new NangoOAuthAppRequiredError(adapter.id);
          }
        } catch (err) {
          if (err instanceof NangoError && err.code === "not_configured") {
            throw new ConnectorAuthError(err.message);
          }
          throw err;
        }

        let session;
        try {
          session = await client().createConnectSession({
            workspaceId: ctx.workspaceId,
            allowedIntegrations: [integrationKey],
          });
        } catch (err) {
          if (err instanceof NangoError && err.code === "not_configured") {
            throw new ConnectorAuthError(err.message);
          }
          throw err;
        }
        await updateInstall(ctx.installId, {
          config: {
            ...ctx.config,
            provider: "nango",
            nango_provider: adapter.provider,
            nango_integration_key: integrationKey,
            oauth_app: oauthApp,
          },
        });
        return {
          redirectUrl: session.connectLink ?? `${client().publicUrl}/connect?session_token=${encodeURIComponent(session.token)}`,
          sessionToken: session.token,
        } as { redirectUrl: string; sessionToken: string };
      }

      if (phase === "complete") {
        const connectionId = typeof payload?.connection_id === "string" ? payload.connection_id : null;
        if (!connectionId) throw new ConnectorAuthError("connection_id missing");
        // The connection must exist in Nango under our integration: this is
        // what makes a forged webhook body harmless. A Nango outage still
        // activates (the Connect session was workspace-scoped) but is logged.
        let connectionConfig: Record<string, unknown> = {};
        const integrationKey = installIntegrationKey(ctx.config, adapter.id);
        try {
          const conn = await client().getConnection(connectionId, integrationKey);
          if (!conn) throw new ConnectorAuthError(`${adapter.id}: connection ${connectionId} not found in Nango`);
          connectionConfig = conn.connectionConfig ?? {};
        } catch (err) {
          if (err instanceof ConnectorAuthError) throw err;
          log.warn("connector.nango.connection_lookup_failed", {
            connector: adapter.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        await updateInstall(ctx.installId, {
          status: "active",
          last_error: null,
          config: {
            ...ctx.config,
            provider: "nango",
            nango_provider: adapter.provider,
            nango_integration_key: integrationKey,
            nango_connection_id: connectionId,
            nango_connection_config: connectionConfig,
          },
        });
        return {};
      }

      // revoke
      const connectionId = typeof ctx.config.nango_connection_id === "string" ? ctx.config.nango_connection_id : null;
      const integrationKey = installIntegrationKey(ctx.config, adapter.id);
      if (connectionId) {
        try {
          await client().deleteConnection(connectionId, integrationKey);
        } catch (err) {
          log.warn("connector.nango.revoke_failed", {
            connector: adapter.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (installOAuthAppKind(ctx.config) === "own") {
        // The workspace's own integration carries its client secret: it goes
        // with the install (Nango deletes the remaining connections with it).
        try {
          await deleteOwnOAuthApp(client(), adapter.id, ctx.workspaceId);
        } catch (err) {
          log.warn("connector.nango.own_app_delete_failed", {
            connector: adapter.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return {};
    },

    async fullSync(ctx, cursor): Promise<SyncResult & { nodes: ContextNodeInput[] }> {
      const connectionId = typeof ctx.config.nango_connection_id === "string" ? ctx.config.nango_connection_id : null;
      if (!connectionId) {
        throw new ConnectorAuthError(`${adapter.id}: not connected yet (no Nango connection on the install)`);
      }
      const startedAt = new Date();
      const since = sinceFor(ctx.config, cursor ?? null, startedAt);
      // Adapters hard-code the shared key; route them to the install's
      // integration (own OAuth app or shared) without touching any adapter.
      const { signals, stats } = await adapter.fetchChanges({
        client: withIntegrationKey(client(), installIntegrationKey(ctx.config, adapter.id)),
        connectionId,
        connectionConfig: (ctx.config.nango_connection_config as Record<string, unknown> | undefined) ?? {},
        config: ctx.config,
        since,
        limit: SIGNALS_PER_RUN,
      });

      // Slack signals of a channel a Nexo owns go to that Nexo's window
      // instead (its flush ingests them); the rest are ingested as always.
      const routed = await routeNangoSignalsToNexos({
        workspaceId: ctx.workspaceId,
        installId: ctx.installId,
        connectorId: adapter.id,
        config: ctx.config,
        signals,
      });

      const summary = await ingestSignals({
        workspaceId: ctx.workspaceId,
        connectorId: adapter.id,
        installId: ctx.installId,
        sourceHint: adapter.sourceHint,
        guidance: typeof ctx.config.ingest_guidance === "string" ? ctx.config.ingest_guidance : null,
        signals: routed.legacy,
      });

      // Re-read the install: the webhook/config routes may have written to
      // `config` while this ran, and a stale spread would clobber them.
      const fresh = await getInstallById(ctx.installId);
      await updateInstall(ctx.installId, {
        config: {
          ...(fresh?.config ?? ctx.config),
          last_cursor: startedAt.toISOString(),
          last_run_stats: { at: startedAt.toISOString(), ...summary, ...(stats ?? {}), ...(routed.windowed ? { nexo_windowed: routed.windowed } : {}) },
        },
      });

      log.info("connector.nango.run", { workspace_id: ctx.workspaceId, connector: adapter.id, since: since.toISOString(), ...summary });
      return {
        processed: signals.length,
        byKind: { signal: signals.length, candidate: summary.candidates, accepted: summary.accepted, conflict: summary.conflicts },
        hasMore: false,
        cursor: null,
        nodes: [],
      };
    },

    async handleWebhook(): Promise<WebhookOutcome> {
      // Nango-backed connectors poll on cadence; provider webhooks are not wired.
      return { nodes: [] };
    },

    toContextNode(): ContextNodeInput | null {
      return null;
    },
  };
  return connector;
}

/** Register every adapter. Called from `../bootstrap.ts`. */
export function registerNangoConnectors(adapters: readonly NangoAdapter[]): void {
  for (const adapter of adapters) registerConnector(nangoConnector(adapter));
}

export type { ConnectorContext };
