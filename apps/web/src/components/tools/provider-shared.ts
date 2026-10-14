/**
 * Pure types + helpers for the Tools surface (`tool-providers-view.tsx`,
 * `provider-modal.tsx`): the provider form model, endpoint validation,
 * identity inferred from the endpoint host, sanitizing of metadata an MCP
 * server declares about itself (untrusted), and the request bodies for
 * `/api/capabilities`. No React here — everything is unit-testable in
 * isolation (`provider-shared.test.ts`).
 */

export type ProviderKind = "mcp_server" | "workflow";
export type AuthType = "none" | "oauth" | "bearer" | "header";
type CredentialMode = "preserve" | "replace";

/**
 * The raw bearer token / header value is write-only: it travels to the API
 * once (create, discovery, or an update with `credentialMode: "replace"`),
 * where it is stored in Supabase Vault, and never comes back. Bound to what a
 * header value can reasonably be; the API enforces its own limit too.
 */
export const MAX_SECRET_LENGTH = 4096;

export interface Capability {
  id: string;
  key: string;
  type: ProviderKind | "api" | string;
  provider: string;
  title: string;
  description: string;
  provenance?: Record<string, unknown> | null;
  status: "draft" | "approved" | "deprecated" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface DeclaredMcpMetadata {
  title?: string;
  name?: string;
  description?: string;
  version?: string;
}

export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** The Add/Edit provider form, as the modal edits it; `EMPTY_FORM` is a new provider. */
export interface ProviderForm {
  capabilityId: string;
  expectedUpdatedAt: string;
  type: ProviderKind;
  title: string;
  provider: string;
  description: string;
  endpointUrl: string;
  remoteTool: string;
  tools: DiscoveredTool[];
  authType: AuthType;
  authHeaderName: string;
  /** Write-only credential typed by the user; empty when editing unless they chose "Replace credential". */
  secret: string;
  oauthAttemptId: string;
  logoUrl: string;
  logoSource: string;
  declaredMetadata: DeclaredMcpMetadata;
  credentialMode: CredentialMode;
  credentialConfigured: boolean;
}

export interface ProviderDetail {
  capability: Capability & { provenance?: Record<string, unknown> | null };
  version: {
    contract: {
      protocol?: string;
      tools?: DiscoveredTool[];
      tool?: DiscoveredTool;
    };
  };
  connection: {
    endpoint_url: string;
    auth_type: AuthType;
    auth_header_name: string | null;
    timeout_ms: number;
    credential_configured: boolean;
  };
}

export interface InferredProviderMetadata {
  title: string;
  provider: string;
  description: string;
}

export const EMPTY_FORM: ProviderForm = {
  capabilityId: "",
  expectedUpdatedAt: "",
  type: "mcp_server",
  title: "",
  provider: "",
  description: "",
  endpointUrl: "",
  remoteTool: "",
  tools: [],
  authType: "none",
  authHeaderName: "",
  secret: "",
  oauthAttemptId: "",
  logoUrl: "",
  logoSource: "",
  declaredMetadata: {},
  credentialMode: "replace",
  credentialConfigured: false,
};

const PROVIDER_NAMES: Record<string, string> = {
  atlassian: "Atlassian",
  cloudflare: "Cloudflare",
  github: "GitHub",
  githubcopilot: "GitHub Copilot",
  google: "Google",
  linear: "Linear",
  microsoft: "Microsoft",
  notion: "Notion",
  sentry: "Sentry",
  stripe: "Stripe",
  supabase: "Supabase",
};

const COUNTRY_CODE_SUFFIXES = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

/** Providers are reached server-side: https only, and never with credentials in the URL. */
export function isValidHttpsProviderEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Only surrounding whitespace is stripped (a pasted token often carries a
 * trailing newline); anything inside is the user's, verbatim.
 */
export function normalizeSecret(value: string): string {
  return value.trim();
}

export function isSecretValid(value: string): boolean {
  const secret = normalizeSecret(value);
  return secret.length > 0 && secret.length <= MAX_SECRET_LENGTH;
}

/**
 * Can this form be saved? `authConfirmed` is the modal's "the user chose an
 * auth method" flag; editing with `preserve` only needs a credential to exist.
 */
export function isProviderConnectionValid(
  form: Pick<ProviderForm, "endpointUrl" | "authType" | "oauthAttemptId" | "authHeaderName" | "secret">
    & Partial<Pick<ProviderForm, "credentialMode" | "credentialConfigured">>,
  authConfirmed: boolean,
): boolean {
  if (!authConfirmed || !isValidHttpsProviderEndpoint(form.endpointUrl)) return false;
  if (form.authType === "none") return true;
  if (form.credentialMode === "preserve") return Boolean(form.credentialConfigured);
  if (form.authType === "oauth") return Boolean(form.oauthAttemptId);
  if (!isSecretValid(form.secret)) return false;
  return form.authType === "bearer" || Boolean(form.authHeaderName.trim());
}

/**
 * Guess title/provider/description from the endpoint host (`mcp.stripe.com`
 * → Stripe), skipping generic labels like `api` or `mcp` in favour of the
 * path. Only a starting point for the form; discovery refines it.
 */
export function inferProviderMetadata(endpointUrl: string): InferredProviderMetadata | null {
  if (!isValidHttpsProviderEndpoint(endpointUrl)) return null;
  const url = new URL(endpointUrl);
  const labels = url.hostname.toLowerCase().split(".").filter(Boolean);
  let providerLabel = labels.length >= 2 ? labels.at(-2)! : labels[0] ?? "";
  if (labels.length >= 3 && labels.at(-1)?.length === 2 && COUNTRY_CODE_SUFFIXES.has(labels.at(-2) ?? "")) {
    providerLabel = labels.at(-3)!;
  }
  if (["api", "connect", "gateway", "mcp", "server", "www"].includes(providerLabel)) {
    const pathLabel = url.pathname.split("/").filter(Boolean).find((part) => !["api", "mcp", "v1"].includes(part.toLowerCase()));
    providerLabel = pathLabel ?? "provider";
  }
  const provider = PROVIDER_NAMES[providerLabel] ?? titleizeProvider(providerLabel);
  if (!provider) return null;
  return {
    title: provider,
    provider,
    description: `${provider} tools connected through MCP.`,
  };
}

export function describeDiscoveredProvider(provider: string, toolCount: number): string {
  const name = provider.trim() || "Provider";
  return `${name} MCP server exposing ${toolCount} tool${toolCount === 1 ? "" : "s"}.`;
}

function titleizeProvider(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

/**
 * Metadata a remote MCP server declares about itself is untrusted: strip
 * format/control characters, collapse whitespace, cap the length.
 */
export function sanitizeUntrustedMetadata(value: unknown, maxLength = 100): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function sanitizeDeclaredMetadata(value: DeclaredMcpMetadata | null | undefined): DeclaredMcpMetadata {
  if (!value) return {};
  const title = sanitizeUntrustedMetadata(value.title, 100);
  const name = sanitizeUntrustedMetadata(value.name, 100);
  const description = sanitizeUntrustedMetadata(value.description, 500);
  const version = sanitizeUntrustedMetadata(value.version, 80);
  return {
    ...(title ? { title } : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
  };
}

export function declaredLabel(metadata: DeclaredMcpMetadata, endpointTitle: string): string | null {
  const value = metadata.title || metadata.name;
  return value && value.toLocaleLowerCase() !== endpointTitle.toLocaleLowerCase() ? value : null;
}

/**
 * What identifies a connection for "changed since discovery?": endpoint +
 * auth, not labels. A different token is a different connection (discovery
 * must re-run with it), but the token itself must never appear in the key —
 * the fingerprint is compared, kept in refs and could end up in a log — so
 * only its length and a cheap non-reversible digest go in.
 */
export function connectionFingerprint(form: ProviderForm): string {
  return [
    form.type,
    form.endpointUrl.trim(),
    form.authType,
    form.oauthAttemptId,
    form.authHeaderName.trim(),
    secretDigest(form.secret),
  ].join("\u0000");
}

/** FNV-1a over the normalized secret: collision-tolerant (a false "same" only skips one auto-discovery), never reversible. */
function secretDigest(value: string): string {
  const secret = normalizeSecret(value);
  if (!secret) return "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < secret.length; index += 1) {
    hash ^= secret.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${secret.length}:${hash.toString(16)}`;
}

export function sameConnection(left: ProviderForm, right: ProviderForm): boolean {
  return connectionFingerprint(left) === connectionFingerprint(right);
}

/**
 * Seed the edit form from the detail endpoint. Secrets never come back, so
 * `credentialMode` starts as `preserve` unless the provider needs no auth.
 */
export function providerFormFromDetail(detail: ProviderDetail): ProviderForm {
  const capability = detail.capability;
  const contract = detail.version.contract;
  const provenance = capability.provenance ?? {};
  const declared = provenance.mcp_declared_metadata;
  const type: ProviderKind = capability.type === "mcp_server" ? "mcp_server" : "workflow";
  return {
    capabilityId: capability.id,
    expectedUpdatedAt: capability.updated_at,
    type,
    title: capability.title,
    provider: capability.provider,
    description: capability.description,
    endpointUrl: detail.connection.endpoint_url,
    remoteTool: type === "workflow" ? contract.tool?.name ?? "" : "",
    tools: type === "mcp_server" ? contract.tools ?? [] : [],
    authType: detail.connection.auth_type,
    authHeaderName: detail.connection.auth_header_name ?? "",
    secret: "",
    oauthAttemptId: "",
    logoUrl: typeof provenance.logo_url === "string" ? provenance.logo_url : "",
    logoSource: typeof provenance.logo_source === "string" ? provenance.logo_source : "",
    declaredMetadata: declared && typeof declared === "object" && !Array.isArray(declared)
      ? sanitizeDeclaredMetadata(declared as DeclaredMcpMetadata)
      : {},
    credentialMode: detail.connection.auth_type === "none" ? "replace" : "preserve",
    credentialConfigured: detail.connection.credential_configured,
  };
}

export function buildProvenance(form: ProviderForm, endpoint: URL): Record<string, unknown> {
  return {
    configured_from: "connections",
    endpoint_origin: endpoint.origin,
    endpoint_host: endpoint.hostname,
    identity_anchor: "endpoint_host",
    ...(Object.keys(form.declaredMetadata).length
      ? { mcp_declared_metadata: form.declaredMetadata, mcp_declared_metadata_verified: false }
      : {}),
    ...(form.logoUrl ? {
      logo_url: form.logoUrl,
      logo_source: form.logoSource || "endpoint_host",
      logo_identity_verified: false,
    } : {}),
  };
}

/**
 * Body for `POST /api/capabilities` and `POST /api/capabilities/discover`:
 * the raw token rides along as `secret` so the API can store it (create) or
 * probe with it (discovery). Never log or display the result.
 */
export function buildConnection(form: ProviderForm, endpoint = new URL(form.endpointUrl)): Record<string, unknown> {
  const connection: Record<string, unknown> = {
    endpointUrl: endpoint.toString(),
    authType: form.authType,
    allowedHosts: [endpoint.hostname],
    timeoutMs: 15000,
  };
  if (form.authType === "oauth") connection.oauthAttemptId = form.oauthAttemptId;
  if (form.authType === "bearer" || form.authType === "header") connection.secret = normalizeSecret(form.secret);
  if (form.authType === "header") connection.authHeaderName = form.authHeaderName.trim();
  return connection;
}

/**
 * Body for `PATCH /api/capabilities/:id`. With `credentialMode: "preserve"`
 * the stored credential is kept and nothing secret is sent; with `replace`
 * the new token (or OAuth attempt) travels exactly as on create.
 */
export function buildUpdateConnection(form: ProviderForm, endpoint = new URL(form.endpointUrl)): Record<string, unknown> {
  const connection: Record<string, unknown> = {
    endpointUrl: endpoint.toString(),
    authType: form.authType,
    credentialMode: form.authType === "none" ? "replace" : form.credentialMode,
    allowedHosts: [endpoint.hostname],
    timeoutMs: 15000,
  };
  if (form.credentialMode === "replace" && form.authType === "oauth") connection.oauthAttemptId = form.oauthAttemptId;
  if (form.credentialMode === "replace" && (form.authType === "bearer" || form.authType === "header")) connection.secret = normalizeSecret(form.secret);
  if (form.authType === "header") connection.authHeaderName = form.authHeaderName.trim();
  return connection;
}

export function slugify(value: string) {
  const slug = value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (/^[a-z]/.test(slug) ? slug : `tool_${slug}`).slice(0, 63);
}

export function logoFromProvenance(provenance: Capability["provenance"]): string | null {
  const value = provenance?.logo_url;
  return typeof value === "string" && value.startsWith("https://") ? value : null;
}

export function endpointHostFromProvenance(provenance: Capability["provenance"]): string | null {
  const explicit = provenance?.endpoint_host;
  if (typeof explicit === "string" && explicit) return explicit;
  const origin = provenance?.endpoint_origin;
  if (typeof origin !== "string") return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

export function providerLogoSrc(workspaceId: string, capabilityId: string, version: string): string {
  return `/api/capabilities/provider-logo?workspace_id=${encodeURIComponent(workspaceId)}&capability_id=${encodeURIComponent(capabilityId)}&v=${encodeURIComponent(version)}`;
}

/**
 * Merge a discovery result into the current form. On a NEW provider the
 * inferred identity (title/provider/description) fills the form; when
 * EDITING an existing capability the user's connection name and metadata
 * are preserved — re-running discovery must never clobber a custom rename
 * (e.g. "Supabase Prod" vs "Supabase E2E" pointing at the same provider).
 */
export function mergeDiscoveryIntoForm(
  current: ProviderForm,
  discovered: {
    title: string;
    provider: string;
    description: string;
    tools: DiscoveredTool[];
    logoUrl: string;
    logoSource: string;
    declaredMetadata: DeclaredMcpMetadata;
  },
): ProviderForm {
  const editing = Boolean(current.capabilityId);
  return {
    ...current,
    ...(editing ? {} : {
      title: discovered.title,
      provider: discovered.provider,
      description: discovered.description,
    }),
    tools: discovered.tools,
    logoUrl: discovered.logoUrl,
    logoSource: discovered.logoSource,
    declaredMetadata: discovered.declaredMetadata,
  };
}
