/**
 * Thin client over the self-hosted Nango REST API.
 *
 * Nango is the auth + proxy layer for the long tail of integrations
 * (docs/integrations-nango.md): it owns the OAuth/API-key flows and the
 * connection credentials; we own what to fetch and what NEXO does with it.
 *
 * Only global `fetch` — no SDK. Every call is `Authorization: Bearer
 * NANGO_SECRET_KEY`. Endpoints follow the public reference
 * (https://nango.dev/docs/reference/backend/http-api):
 *
 *   POST   /connect/sessions                       → { data: { token, connect_link, expires_at } }
 *   GET    /connections/:id?provider_config_key=…  → { … }
 *   DELETE /connections/:id?provider_config_key=…  → { success: true }
 *   GET    /integrations                           → { data: [{ unique_key, provider, … }] }
 *   GET    /integrations/:key?include=credentials  → { data: { unique_key, provider, credentials: { type, client_id, scopes } | null } }
 *   POST   /integrations                           → { data: { unique_key, … } }
 *   PATCH  /integrations/:key                      → { data: { unique_key, … } }   (credentials replace, never merge)
 *   DELETE /integrations/:key                      → { success: true }
 *   ANY    /proxy/<path>                           → the provider's response, verbatim
 *
 * `NangoClient` takes its fetch as a dependency so tests never touch the
 * network, and `nangoClient()` builds the production one from env.
 */
import { log } from "@bcontext-dev/contract/log";

export class NangoError extends Error {
  constructor(
    public readonly code: "not_configured" | "http_error" | "bad_response",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "NangoError";
  }
}

export interface NangoConfig {
  /** Base URL of the Nango server, e.g. https://nango.example.com */
  serverUrl: string;
  secretKey: string;
  /** Public URL the browser uses for the Connect UI; defaults to serverUrl. */
  publicUrl?: string;
}

export interface ConnectSession {
  token: string;
  connectLink: string | null;
  expiresAt: string | null;
}

export interface NangoConnection {
  id: string;
  providerConfigKey: string;
  provider: string;
  connectionConfig: Record<string, unknown>;
  createdAt: string | null;
}

export interface NangoIntegration {
  uniqueKey: string;
  provider: string;
  displayName: string | null;
}

/**
 * OAuth integrations are created with this client id/secret until the owner
 * registers the OAuth app and pastes the real values in the Nango dashboard.
 * The catalog reads it back to flag those entries as `needs_oauth_app`.
 */
export const NANGO_PLACEHOLDER_CREDENTIAL = "pending-owner-setup";

export interface NangoIntegrationCredentials {
  type: string | null;
  clientId: string | null;
  scopes: string | null;
}

export interface NangoIntegrationWithCredentials extends NangoIntegration {
  credentials: NangoIntegrationCredentials | null;
}

export type NangoNewIntegrationCredentials =
  | { type: "OAUTH2" | "OAUTH1" | "OAUTH2_CC"; client_id: string; client_secret: string; scopes?: string }
  | { type: "APP"; app_id: string; app_link: string; private_key: string };

export interface ProxyRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  providerConfigKey: string;
  connectionId: string;
  /** Provider path, leading slash optional, e.g. "/rest/api/3/search". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Nango's `Base-Url-Override`: call another host of the same provider (regional API, download host). */
  baseUrlOverride?: string;
  retries?: number;
  /** `buffer` returns the raw body as a Buffer (binary downloads: docx, xlsx); default decodes json/text. */
  responseType?: "auto" | "buffer";
}

export interface ProxyResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
  headers: Headers;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function readNangoConfig(env: NodeJS.ProcessEnv = process.env): NangoConfig | null {
  const serverUrl = env.NANGO_SERVER_URL?.replace(/\/+$/, "");
  const secretKey = env.NANGO_SECRET_KEY;
  if (!serverUrl || !secretKey) return null;
  return {
    serverUrl,
    secretKey,
    publicUrl: env.NANGO_PUBLIC_URL?.replace(/\/+$/, "") || serverUrl,
  };
}

export function isNangoConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readNangoConfig(env) !== null;
}

export class NangoClient {
  constructor(
    private readonly config: NangoConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  get publicUrl(): string {
    return this.config.publicUrl ?? this.config.serverUrl;
  }

  /**
   * A Connect session scoped to one workspace and one integration. The
   * returned token drives `@nangohq/frontend`'s Connect UI; `connect_link`
   * is the same thing as a plain URL for a new window.
   */
  async createConnectSession(input: {
    workspaceId: string;
    allowedIntegrations: string[];
    displayName?: string;
  }): Promise<ConnectSession> {
    const payload = await this.json<{ data?: { token?: string; connect_link?: string; expires_at?: string } }>(
      "/connect/sessions",
      {
        method: "POST",
        body: JSON.stringify({
          allowed_integrations: input.allowedIntegrations,
          tags: { end_user_id: input.workspaceId, organization_id: input.workspaceId },
          // Older servers still read `end_user`; harmless on new ones.
          end_user: { id: input.workspaceId, display_name: input.displayName ?? "Bcontext workspace" },
        }),
      },
    );
    const token = payload.data?.token;
    if (!token) throw new NangoError("bad_response", "connect session without token");
    return {
      token,
      connectLink: payload.data?.connect_link ?? null,
      expiresAt: payload.data?.expires_at ?? null,
    };
  }

  async getConnection(connectionId: string, providerConfigKey: string): Promise<NangoConnection | null> {
    const res = await this.raw(
      `/connections/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerConfigKey)}`,
      { method: "GET" },
    );
    if (res.status === 404) return null;
    const body = await this.parse<Record<string, unknown>>(res);
    const row = (body.data as Record<string, unknown> | undefined) ?? body;
    return {
      id: String(row.id ?? row.connection_id ?? connectionId),
      providerConfigKey: String(row.provider_config_key ?? providerConfigKey),
      provider: String(row.provider ?? ""),
      connectionConfig: (row.connection_config as Record<string, unknown> | undefined) ?? {},
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
    };
  }

  async deleteConnection(connectionId: string, providerConfigKey: string): Promise<boolean> {
    const res = await this.raw(
      `/connections/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerConfigKey)}`,
      { method: "DELETE" },
    );
    if (res.status === 404) return false;
    await this.parse(res);
    return true;
  }

  async listIntegrations(): Promise<NangoIntegration[]> {
    const body = await this.json<{ data?: Array<Record<string, unknown>>; configs?: Array<Record<string, unknown>> }>(
      "/integrations",
      { method: "GET" },
    );
    const rows = body.data ?? body.configs ?? [];
    return rows.map((row) => ({
      uniqueKey: String(row.unique_key ?? ""),
      provider: String(row.provider ?? ""),
      displayName: typeof row.display_name === "string" ? row.display_name : null,
    }));
  }

  /**
   * One integration with its credential *metadata* (type, client id, scopes —
   * never the secret): `GET /integrations/:key?include=credentials`. Null
   * when Nango does not know the key. API_KEY/BASIC providers come back with
   * `credentials: null`.
   */
  async getIntegration(uniqueKey: string): Promise<NangoIntegrationWithCredentials | null> {
    const res = await this.raw(`/integrations/${encodeURIComponent(uniqueKey)}?include=credentials`, { method: "GET" });
    if (res.status === 404) return null;
    const body = await this.parse<{ data?: Record<string, unknown> }>(res);
    const row = body.data ?? {};
    const creds = (row.credentials as Record<string, unknown> | null | undefined) ?? null;
    return {
      uniqueKey: String(row.unique_key ?? uniqueKey),
      provider: String(row.provider ?? ""),
      displayName: typeof row.display_name === "string" ? row.display_name : null,
      credentials: creds
        ? {
            type: typeof creds.type === "string" ? creds.type : null,
            clientId: typeof creds.client_id === "string" ? creds.client_id : null,
            scopes: typeof creds.scopes === "string" ? creds.scopes : null,
          }
        : null,
    };
  }

  /**
   * Every integration with its credential metadata. The list endpoint does
   * not take `include`, so this is the list plus one `getIntegration` per
   * row, a few at a time; callers cache the answer (src/lib/nango/setup.ts).
   */
  async listIntegrationsWithCredentials(): Promise<NangoIntegrationWithCredentials[]> {
    const rows = await this.listIntegrations();
    const out: NangoIntegrationWithCredentials[] = [];
    const batch = 8;
    for (let i = 0; i < rows.length; i += batch) {
      const slice = rows.slice(i, i + batch);
      const detailed = await Promise.all(slice.map((row) => this.getIntegration(row.uniqueKey)));
      for (let j = 0; j < slice.length; j++) {
        out.push(detailed[j] ?? { ...slice[j]!, credentials: null });
      }
    }
    return out;
  }

  async createIntegration(input: {
    uniqueKey: string;
    provider: string;
    displayName?: string;
    credentials?: NangoNewIntegrationCredentials;
  }): Promise<NangoIntegration> {
    const body = await this.json<{ data?: Record<string, unknown> }>("/integrations", {
      method: "POST",
      body: JSON.stringify({
        unique_key: input.uniqueKey,
        provider: input.provider,
        ...(input.displayName ? { display_name: input.displayName } : {}),
        ...(input.credentials ? { credentials: input.credentials } : {}),
      }),
    });
    const row = body.data ?? {};
    return {
      uniqueKey: String(row.unique_key ?? input.uniqueKey),
      provider: String(row.provider ?? input.provider),
      displayName: typeof row.display_name === "string" ? row.display_name : null,
    };
  }

  /**
   * Replace an integration's credentials and/or display name
   * (`PATCH /integrations/:key`). Used for a workspace's own OAuth app; the
   * secret goes straight to Nango and is never echoed back.
   */
  async updateIntegration(
    uniqueKey: string,
    patch: { displayName?: string; credentials?: NangoNewIntegrationCredentials },
  ): Promise<NangoIntegration> {
    const body = await this.json<{ data?: Record<string, unknown> }>(`/integrations/${encodeURIComponent(uniqueKey)}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...(patch.displayName ? { display_name: patch.displayName } : {}),
        ...(patch.credentials ? { credentials: patch.credentials } : {}),
      }),
    });
    const row = body.data ?? {};
    return {
      uniqueKey: String(row.unique_key ?? uniqueKey),
      provider: String(row.provider ?? ""),
      displayName: typeof row.display_name === "string" ? row.display_name : null,
    };
  }

  /** `DELETE /integrations/:key`; false when Nango did not know the key. */
  async deleteIntegration(uniqueKey: string): Promise<boolean> {
    const res = await this.raw(`/integrations/${encodeURIComponent(uniqueKey)}`, { method: "DELETE" });
    if (res.status === 404) return false;
    await this.parse(res);
    return true;
  }

  /**
   * Call the provider's API through Nango. The response comes back as the
   * provider sent it (status + body); JSON is parsed when the content type
   * says so, otherwise `data` is the raw text.
   */
  async proxy<T = unknown>(req: ProxyRequest): Promise<ProxyResponse<T>> {
    const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
    const url = new URL(`${this.config.serverUrl}/proxy${path}`);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.secretKey}`,
      "Connection-Id": req.connectionId,
      "Provider-Config-Key": req.providerConfigKey,
      Retries: String(req.retries ?? 2),
      ...(req.baseUrlOverride ? { "Base-Url-Override": req.baseUrlOverride } : {}),
      ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    for (const [key, value] of Object.entries(req.headers ?? {})) {
      headers[`nango-proxy-${key}`] = value;
    }
    const res = await this.fetchImpl(url.toString(), {
      method: req.method,
      headers,
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const data = (
      req.responseType === "buffer"
        ? Buffer.from(await res.arrayBuffer())
        : contentType.includes("json")
          ? await res.json().catch(() => null)
          : await res.text()
    ) as T;
    if (!res.ok) {
      log.warn("nango.proxy.error", {
        provider_config_key: req.providerConfigKey,
        status: res.status,
        path,
      });
    }
    return { status: res.status, ok: res.ok, data, headers: res.headers };
  }

  // -- internals -----------------------------------------------------------

  private async raw(path: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.secretKey}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    };
    return this.fetchImpl(`${this.config.serverUrl}${path}`, { ...init, headers });
  }

  private async json<T>(path: string, init: RequestInit): Promise<T> {
    const res = await this.raw(path, init);
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      throw new NangoError(
        "http_error",
        `nango ${res.status}: ${text.slice(0, 300)}`,
        res.status,
      );
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NangoError("bad_response", "nango returned non-JSON");
    }
  }
}

let cached: NangoClient | null = null;
let cachedKey = "";

/** Production client from env; throws `not_configured` when NANGO_* is unset. */
export function nangoClient(): NangoClient {
  const config = readNangoConfig();
  if (!config) {
    throw new NangoError(
      "not_configured",
      "Nango is not configured on the server: set NANGO_SERVER_URL and NANGO_SECRET_KEY.",
    );
  }
  const key = `${config.serverUrl}|${config.secretKey}|${config.publicUrl}`;
  if (!cached || cachedKey !== key) {
    cached = new NangoClient(config);
    cachedKey = key;
  }
  return cached;
}
