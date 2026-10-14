/**
 * Managed OAuth 2.1 for external MCP capabilities. An admin points Bcontext
 * at an MCP endpoint; the server's WWW-Authenticate challenge leads to the
 * protected-resource and authorization-server metadata (MCP auth spec), a
 * client is registered dynamically when the issuer allows it, a person
 * consents in a browser, and the tokens land in the secret store referenced
 * by the `capability_oauth_*` rows — never in an API response, the audit log
 * or an MCP transcript.
 *
 * Flow: `startOAuthAuthorization` (creates an attempt, returns the URL) →
 * `completeOAuthAuthorization` (callback, exchanges the code) →
 * `registerOAuthCapability` / `attachOAuthCredential` (consume the attempt
 * into a connection) → `getOAuthAccessTokenForConnection` at invoke time,
 * which refreshes under a lease so concurrent gateway calls cannot race the
 * single-use refresh token. All upstream HTTP goes through the pinned,
 * host-allowlisted fetch from `egress.ts` with a per-flow time budget.
 *
 * `OAuthDependencies` exists so tests can inject the repository, secret
 * store and clock; the defaults are Supabase and the connectors secret store.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { deleteSecret, getSecret, putNamedSecret, type SecretRef } from "@/lib/connectors/secrets";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createPinnedFetch, resolveSafeTarget } from "./egress";

const FLOW_TTL_MS = 10 * 60_000;
const REFRESH_LEASE_MS = 30_000;
const REFRESH_HTTP_TIMEOUT_MS = 20_000;
const OAUTH_HTTP_TIMEOUT_MS = 20_000;
const OAUTH_START_HTTP_BUDGET_MS = 30_000;
const OAUTH_MAX_RESPONSE_BYTES = 1_000_000;
const OAUTH_CLIENT_REUSE_TTL_MS = 10 * 60_000;
const CLIENT_REGISTRATION_LEASE_MS = 2 * 60_000;
const REFRESH_SKEW_MS = 60_000;
const MAX_REFRESH_WAIT_MS = 5_000;
const CALLBACK_PATH = "/api/capabilities/oauth/callback";
const MCP_PROTOCOL_VERSION = "2025-11-25";

export type OAuthClientStatus = "pending" | "active" | "failed" | "revoked";
export type OAuthAttemptStatus =
  | "pending"
  | "authorized"
  | "connected"
  | "failed"
  | "expired"
  | "cancelled";
export type OAuthCredentialStatus =
  | "active"
  | "refreshing"
  | "needs_reauth"
  | "revoked"
  | "failed";

/** Stable-coded OAuth failure; `httpStatus` is what the REST routes answer with. */
export class CapabilityOAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "CapabilityOAuthError";
  }
}

export interface OAuthClientRecord {
  id: string;
  workspaceId: string;
  issuer: string;
  redirectUri: string;
  secretRef: SecretRef | null;
  status: OAuthClientStatus;
  updatedAt: string;
}

export interface OAuthAttemptRecord {
  id: string;
  workspaceId: string;
  createdBy: string;
  endpointUrl: string;
  allowedHosts: string[];
  issuer: string;
  resourceUrl: string;
  scopes: string[];
  stateHash: string;
  secretRef: SecretRef;
  status: OAuthAttemptStatus;
  expiresAt: string;
  connectedAt: string | null;
  consumedAt: string | null;
  capabilityId: string | null;
  errorCode: string | null;
}

export interface OAuthCredentialRecord {
  id: string;
  workspaceId: string;
  connectionId: string;
  attemptId: string;
  secretRef: SecretRef;
  issuer: string;
  resourceUrl: string;
  scopes: string[];
  status: OAuthCredentialStatus;
  tokenExpiresAt: string | null;
  refreshLeaseToken: string | null;
  refreshLeaseUntil: string | null;
  revision: number;
}

interface ClientSecretBundle {
  clientInformation: OAuthClientInformationMixed;
  discoveryState: OAuthDiscoveryState;
  oauthHosts: string[];
}

interface AttemptSecretBundle {
  clientInformation: OAuthClientInformationMixed;
  discoveryState: OAuthDiscoveryState;
  oauthHosts: string[];
  codeVerifier?: string;
  tokens?: OAuthTokens;
  tokenExpiresAt?: string | null;
}

export interface OAuthAttemptStatusResult {
  id: string;
  status: OAuthAttemptStatus;
  endpointUrl: string;
  scopes: string[];
  expiresAt: string;
  connectedAt: string | null;
  errorCode: string | null;
}

export interface OAuthAccess {
  accessToken: string;
  tokenType: string;
  expiresAt: string | null;
  oauthHosts: string[];
}

/**
 * Persistence seam over `capability_oauth_clients|attempts|credentials`.
 * Status transitions take an `expectedStatus`/`expectedRevision` and return
 * null when they lose the race, which is how callers detect concurrency.
 */
export interface OAuthRepository {
  isWorkspaceAdmin(input: {
    workspaceId: string;
    userId: string;
  }): Promise<boolean>;
  expireAttempts(input: {
    workspaceId: string;
    now: string;
    limit: number;
  }): Promise<Array<{ id: string; secretRef: SecretRef }>>;
  findActiveClient(input: {
    workspaceId: string;
    issuer: string;
    redirectUri: string;
  }): Promise<OAuthClientRecord | null>;
  createPendingClient(input: {
    workspaceId: string;
    issuer: string;
    redirectUri: string;
  }): Promise<OAuthClientRecord>;
  activateClient(input: {
    id: string;
    workspaceId: string;
    secretRef: SecretRef;
  }): Promise<OAuthClientRecord>;
  failClient(input: { id: string; workspaceId: string; errorCode: string }): Promise<void>;
  invalidateClient(input: { workspaceId: string; issuer: string }): Promise<void>;
  createAttempt(input: Omit<OAuthAttemptRecord, "connectedAt" | "consumedAt" | "capabilityId" | "errorCode">): Promise<OAuthAttemptRecord>;
  getAttemptByStateHash(stateHash: string): Promise<OAuthAttemptRecord | null>;
  getAttempt(input: {
    workspaceId: string;
    attemptId: string;
    createdBy?: string;
  }): Promise<OAuthAttemptRecord | null>;
  updateAttempt(input: {
    id: string;
    workspaceId: string;
    expectedStatus?: OAuthAttemptStatus;
    patch: Partial<Pick<OAuthAttemptRecord,
      "status" | "connectedAt" | "consumedAt" | "capabilityId" | "errorCode" | "secretRef">>;
  }): Promise<OAuthAttemptRecord | null>;
  registerCapability(input: RegisterOAuthCapabilityInput): Promise<RegisterOAuthCapabilityResult>;
  attachCredential(input: {
    workspaceId: string;
    userId: string;
    connectionId: string;
    attemptId: string;
    capabilityId: string;
    endpointUrl: string;
    tokenExpiresAt: string | null;
  }): Promise<OAuthCredentialRecord>;
  getCredentialByConnection(input: {
    workspaceId: string;
    connectionId: string;
  }): Promise<OAuthCredentialRecord | null>;
  claimRefreshLease(input: {
    workspaceId: string;
    credentialId: string;
    expectedRevision: number;
    leaseId: string;
    leaseUntil: string;
    now: string;
  }): Promise<OAuthCredentialRecord | null>;
  finishRefresh(input: {
    workspaceId: string;
    credentialId: string;
    expectedRevision: number;
    leaseId: string;
    status: OAuthCredentialStatus;
    tokenExpiresAt: string | null;
    secretRef?: SecretRef;
    lastError?: string | null;
  }): Promise<OAuthCredentialRecord | null>;
}

/** Where token bundles live; rows only ever hold a `SecretRef` to them. */
export interface OAuthSecretStore {
  get(ref: SecretRef | null): Promise<string | null>;
  put(input: { name: string; plaintext: string }): Promise<SecretRef>;
  delete?(ref: SecretRef | null): Promise<boolean>;
}

export interface OAuthDependencies {
  repository: OAuthRepository;
  secrets: OAuthSecretStore;
  createPinnedFetch(hosts: readonly string[]): FetchLike;
  now(): Date;
  randomState(): string;
  randomId(): string;
  wait(ms: number): Promise<void>;
}

export interface StartOAuthAuthorizationInput {
  workspaceId: string;
  userId: string;
  endpointUrl: string;
  allowedHosts: string[];
  appOrigin: string;
  clientName?: string;
}

export interface StartOAuthAuthorizationResult {
  attemptId: string;
  authorizationUrl: string;
  expiresAt: string;
  scopes: string[];
  authorizationServer: string;
}

export interface CompleteOAuthAuthorizationInput {
  userId: string;
  state: string;
  code?: string | null;
  error?: string | null;
  errorDescription?: string | null;
  appOrigin: string;
}

export interface CompleteOAuthAuthorizationResult {
  attemptId: string;
  workspaceId: string;
  endpointUrl: string;
  status: "authorized";
  scopes: string[];
  connectedAt: string;
}

export interface AttachOAuthCredentialInput {
  workspaceId: string;
  userId: string;
  attemptId: string;
  connectionId: string;
  capabilityId: string;
  endpointUrl: string;
}

export interface RegisterOAuthCapabilityInput {
  workspaceId: string;
  userId: string;
  attemptId: string;
  expectedEndpointUrl: string;
  key: string;
  provider: string;
  title: string;
  description: string;
  provenance: Record<string, unknown>;
  environment: string;
  contract: Record<string, unknown>;
  contractDigest: string;
  changeSummary: string | null;
  status: "draft" | "approved";
  timeoutMs: number;
}

export interface RegisterOAuthCapabilityResult {
  capabilityId: string;
  versionId: string;
  connectionId: string;
  created: boolean;
}

/**
 * Minimal persistent provider compatible with the MCP SDK. It deliberately
 * captures redirects rather than navigating: route handlers return the URL to
 * a browser popup, while secrets remain server-side.
 */
export class ManagedOAuthClientProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;

  constructor(
    private readonly values: {
      redirectUrl: string;
      clientMetadata: OAuthClientMetadata;
      state?: string;
      clientInformation?: OAuthClientInformationMixed;
      tokens?: OAuthTokens;
      codeVerifier?: string;
      discoveryState?: OAuthDiscoveryState;
    },
    private readonly persist: {
      clientInformation?(value: OAuthClientInformationMixed): Promise<void>;
      tokens?(value: OAuthTokens): Promise<void>;
      codeVerifier?(value: string): Promise<void>;
      discoveryState?(value: OAuthDiscoveryState): Promise<void>;
    } = {},
  ) {}

  get redirectUrl(): string {
    return this.values.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.values.clientMetadata;
  }

  state(): string {
    if (!this.values.state) {
      throw new CapabilityOAuthError("oauth_state_missing", "OAuth state is unavailable", 409);
    }
    return this.values.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.values.clientInformation;
  }

  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    this.values.clientInformation = value;
    await this.persist.clientInformation?.(value);
  }

  tokens(): OAuthTokens | undefined {
    return this.values.tokens;
  }

  async saveTokens(value: OAuthTokens): Promise<void> {
    this.values.tokens = value;
    await this.persist.tokens?.(value);
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = new URL(url);
  }

  async saveCodeVerifier(value: string): Promise<void> {
    this.values.codeVerifier = value;
    await this.persist.codeVerifier?.(value);
  }

  codeVerifier(): string {
    if (!this.values.codeVerifier) {
      throw new CapabilityOAuthError("oauth_verifier_missing", "OAuth verifier is unavailable", 409);
    }
    return this.values.codeVerifier;
  }

  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    this.values.discoveryState = value;
    await this.persist.discoveryState?.(value);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.values.discoveryState;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") this.values.clientInformation = undefined;
    if (scope === "all" || scope === "tokens") this.values.tokens = undefined;
    if (scope === "all" || scope === "verifier") this.values.codeVerifier = undefined;
    if (scope === "all" || scope === "discovery") this.values.discoveryState = undefined;
  }
}

/**
 * Discovers the endpoint's authorization server, registers or reuses a
 * client, and returns the authorization URL for a browser popup. The admin
 * role is checked by the caller; hosts outside `allowedHosts` (plus the
 * issuer the metadata names) are refused before any HTTP.
 */
export async function startOAuthAuthorization(
  input: StartOAuthAuthorizationInput,
  overrides?: Partial<OAuthDependencies>,
): Promise<StartOAuthAuthorizationResult> {
  const deps = dependencies(overrides);
  const endpoint = validateEndpoint(input.endpointUrl, input.allowedHosts);
  await expireAttemptsForWorkspace(input.workspaceId, deps);
  const redirectUri = oauthCallbackUrl(input.appOrigin);
  const flowDeadline = Date.now() + OAUTH_START_HTTP_BUDGET_MS;
  const endpointFetch = withFetchTimeout(
    deps.createPinnedFetch(input.allowedHosts),
    OAUTH_HTTP_TIMEOUT_MS,
    { deadlineMs: flowDeadline },
  );
  const challenge = await requestOAuthChallenge(endpoint, endpointFetch);
  const resourceMetadataUrl = challenge.resourceMetadataUrl;
  if (resourceMetadataUrl && !hostAllowed(resourceMetadataUrl.hostname, input.allowedHosts)) {
    throw new CapabilityOAuthError(
      "oauth_metadata_host_not_allowed",
      "OAuth resource metadata host is not allowlisted",
    );
  }

  const resourceMetadata = await discoverOAuthProtectedResourceMetadata(
    endpoint,
    resourceMetadataUrl ? { resourceMetadataUrl } : undefined,
    endpointFetch,
  ).catch((error: unknown) => {
    throw oauthFailure("oauth_resource_discovery_failed", error, 502);
  });
  const resource = validateResource(endpoint, resourceMetadata);
  const issuer = selectIssuer(resourceMetadata);
  await resolveSafeTarget(issuer, [issuer.hostname]);
  const issuerFetch = withFetchTimeout(
    deps.createPinnedFetch([issuer.hostname]),
    OAUTH_HTTP_TIMEOUT_MS,
    { deadlineMs: flowDeadline },
  );
  const metadata = await discoverAuthorizationServerMetadata(issuer, {
    fetchFn: issuerFetch,
    protocolVersion: MCP_PROTOCOL_VERSION,
  }).catch((error: unknown) => {
    throw oauthFailure("oauth_server_discovery_failed", error, 502);
  });
  if (!metadata) {
    throw new CapabilityOAuthError(
      "oauth_server_metadata_missing",
      "Authorization server metadata is unavailable",
      502,
    );
  }
  const oauthHosts = await validateAuthorizationMetadata(issuer, metadata);
  const oauthFetch = withFetchTimeout(
    deps.createPinnedFetch(oauthHosts),
    OAUTH_HTTP_TIMEOUT_MS,
    { deadlineMs: flowDeadline },
  );
  const scopes = selectScopes(challenge.scope, resourceMetadata);
  const scope = scopes.length > 0 ? scopes.join(" ") : undefined;
  const discoveryState: OAuthDiscoveryState = {
    authorizationServerUrl: issuer.href,
    resourceMetadataUrl: resourceMetadataUrl?.href,
    authorizationServerMetadata: metadata,
    resourceMetadata,
  };

  let clientRecord = await deps.repository.findActiveClient({
    workspaceId: input.workspaceId,
    issuer: issuer.href,
    redirectUri,
  });
  let clientBundle = clientRecord
    ? await readClientBundle(clientRecord, deps.secrets).catch(() => null)
    : null;
  let reusedClient = false;

  if (clientRecord && clientBundle) {
    if (!clientRecordReusable(clientRecord, clientBundle.clientInformation, deps.now())) {
      await deps.repository.invalidateClient({
        workspaceId: input.workspaceId,
        issuer: issuer.href,
      });
      clientRecord = null;
      clientBundle = null;
    } else {
      reusedClient = true;
    }
  }

  if (!clientRecord || !clientBundle) {
    if (clientRecord) {
      await deps.repository.failClient({
        id: clientRecord.id,
        workspaceId: input.workspaceId,
        errorCode: "oauth_client_secret_unavailable",
      });
    }
    const registered = await registerManagedOAuthClient({
      workspaceId: input.workspaceId,
      issuer,
      redirectUri,
      metadata,
      clientName: input.clientName,
      scope,
      oauthFetch,
      discoveryState,
      oauthHosts,
    }, deps);
    clientRecord = registered.record;
    clientBundle = registered.bundle;
  }

  const state = deps.randomState();
  const attemptId = deps.randomId();
  const expiresAt = new Date(deps.now().getTime() + FLOW_TTL_MS).toISOString();
  let started = await startAuthorization(issuer, {
    metadata,
    clientInformation: clientBundle.clientInformation,
    redirectUrl: redirectUri,
    scope,
    state,
    resource,
  }).catch((error: unknown) => {
    throw oauthFailure("oauth_authorization_start_failed", error, 502);
  });

  // Some DCR providers retain no registration-management endpoint and can
  // garbage-collect a client even when client_secret_expires_at is zero. A
  // cached client then yields a browser-only `Unrecognized client_id` page,
  // which never reaches our callback. Probe only reused clients and recover
  // once with a fresh DCR registration before returning a popup URL.
  if (reusedClient && await authorizationRejectsClient(
    authorizationProbeUrl(started.authorizationUrl, deps.randomState),
    oauthFetch,
  )) {
    await deps.repository.invalidateClient({
      workspaceId: input.workspaceId,
      issuer: issuer.href,
    });
    const registered = await registerManagedOAuthClient({
      workspaceId: input.workspaceId,
      issuer,
      redirectUri,
      metadata,
      clientName: input.clientName,
      scope,
      oauthFetch,
      discoveryState,
      oauthHosts,
    }, deps);
    clientRecord = registered.record;
    clientBundle = registered.bundle;
    started = await startAuthorization(issuer, {
      metadata,
      clientInformation: clientBundle.clientInformation,
      redirectUrl: redirectUri,
      scope,
      state,
      resource,
    }).catch((error: unknown) => {
      throw oauthFailure("oauth_authorization_start_failed", error, 502);
    });
  }
  const attemptBundle: AttemptSecretBundle = {
    clientInformation: clientBundle.clientInformation,
    discoveryState,
    oauthHosts,
    codeVerifier: started.codeVerifier,
  };
  const secretRef = await deps.secrets.put({
    name: oauthAttemptSecretName(attemptId),
    plaintext: JSON.stringify(attemptBundle),
  });
  try {
    assertVaultRef(secretRef);
    await deps.repository.createAttempt({
      id: attemptId,
      workspaceId: input.workspaceId,
      createdBy: input.userId,
      endpointUrl: endpoint.href,
      allowedHosts: normalizedHosts(input.allowedHosts),
      issuer: issuer.href,
      resourceUrl: resource.href,
      scopes,
      stateHash: hashState(state),
      secretRef,
      status: "pending",
      expiresAt,
    });
  } catch (error) {
    await cleanupSecret(deps.secrets, secretRef);
    throw error;
  }
  return {
    attemptId,
    authorizationUrl: started.authorizationUrl.href,
    expiresAt,
    scopes,
    authorizationServer: issuer.href,
  };
}

/**
 * Callback half: matches `state` to a pending attempt of the same user,
 * re-checks that the user is still a workspace admin, exchanges the code and
 * stores the tokens in the attempt's secret bundle. The attempt becomes
 * `authorized` — not yet attached to any connection.
 */
export async function completeOAuthAuthorization(
  input: CompleteOAuthAuthorizationInput,
  overrides?: Partial<OAuthDependencies>,
): Promise<CompleteOAuthAuthorizationResult> {
  const deps = dependencies(overrides);
  const attempt = await deps.repository.getAttemptByStateHash(hashState(input.state));
  if (!attempt || attempt.createdBy !== input.userId) {
    throw new CapabilityOAuthError("oauth_state_invalid", "OAuth state is invalid", 400);
  }
  if (attempt.status !== "pending") {
    throw new CapabilityOAuthError("oauth_attempt_not_pending", "OAuth attempt is no longer pending", 409);
  }
  if (!await deps.repository.isWorkspaceAdmin({
    workspaceId: attempt.workspaceId,
    userId: input.userId,
  })) {
    const updated = await deps.repository.updateAttempt({
      id: attempt.id,
      workspaceId: attempt.workspaceId,
      expectedStatus: "pending",
      patch: { status: "cancelled", errorCode: "oauth_admin_required" },
    });
    if (!updated) {
      throw new CapabilityOAuthError("oauth_attempt_raced", "OAuth attempt was already completed", 409);
    }
    await cleanupSecret(deps.secrets, updated.secretRef);
    throw new CapabilityOAuthError(
      "oauth_admin_required",
      "Workspace owner or admin access is required",
      403,
    );
  }
  if (Date.parse(attempt.expiresAt) <= deps.now().getTime()) {
    const updated = await deps.repository.updateAttempt({
      id: attempt.id,
      workspaceId: attempt.workspaceId,
      expectedStatus: "pending",
      patch: { status: "expired", errorCode: "oauth_attempt_expired" },
    });
    if (!updated) {
      throw new CapabilityOAuthError("oauth_attempt_raced", "OAuth attempt was already completed", 409);
    }
    await cleanupSecret(deps.secrets, updated.secretRef);
    throw new CapabilityOAuthError("oauth_attempt_expired", "OAuth attempt has expired", 410);
  }
  if (input.error) {
    const errorCode = safeProviderError(input.error);
    const updated = await deps.repository.updateAttempt({
      id: attempt.id,
      workspaceId: attempt.workspaceId,
      expectedStatus: "pending",
      patch: { status: "failed", errorCode },
    });
    if (!updated) {
      throw new CapabilityOAuthError("oauth_attempt_raced", "OAuth attempt was already completed", 409);
    }
    await cleanupSecret(deps.secrets, updated.secretRef);
    throw new CapabilityOAuthError(errorCode, "Authorization was not completed", 400);
  }
  try {
    if (!input.code) {
      throw new CapabilityOAuthError("oauth_code_missing", "Authorization code is missing", 400);
    }
    const bundle = await readAttemptBundle(attempt, deps.secrets);
    if (!bundle.codeVerifier) {
      throw new CapabilityOAuthError("oauth_verifier_missing", "OAuth verifier is unavailable", 409);
    }
    const discovery = bundle.discoveryState;
    const metadata = discovery.authorizationServerMetadata;
    if (!metadata) {
      throw new CapabilityOAuthError("oauth_server_metadata_missing", "Authorization server metadata is unavailable", 409);
    }
    const issuer = new URL(attempt.issuer);
    const resource = new URL(attempt.resourceUrl);
    const redirectUri = oauthCallbackUrl(input.appOrigin);
    if (
      "redirect_uris" in bundle.clientInformation &&
      Array.isArray(bundle.clientInformation.redirect_uris) &&
      !bundle.clientInformation.redirect_uris.includes(redirectUri)
    ) {
      throw new CapabilityOAuthError("oauth_redirect_mismatch", "OAuth callback URI does not match the registered client", 409);
    }
    const tokens = await exchangeAuthorization(issuer, {
      metadata,
      clientInformation: bundle.clientInformation,
      authorizationCode: input.code,
      codeVerifier: bundle.codeVerifier,
      redirectUri,
      resource,
      fetchFn: withFetchTimeout(deps.createPinnedFetch(bundle.oauthHosts), OAUTH_HTTP_TIMEOUT_MS),
    });
    assertBearerTokens(tokens);
    const connectedAt = deps.now().toISOString();
    const nextBundle: AttemptSecretBundle = {
      clientInformation: bundle.clientInformation,
      discoveryState: bundle.discoveryState,
      oauthHosts: bundle.oauthHosts,
      tokens,
      tokenExpiresAt: tokenExpiry(tokens, deps.now()),
    };
    const secretRef = await deps.secrets.put({
      name: oauthAttemptSecretName(attempt.id),
      plaintext: JSON.stringify(nextBundle),
    });
    assertVaultRef(secretRef);
    const updated = await deps.repository.updateAttempt({
      id: attempt.id,
      workspaceId: attempt.workspaceId,
      expectedStatus: "pending",
      patch: {
        status: "authorized",
        connectedAt,
        secretRef,
        errorCode: null,
      },
    });
    if (!updated) {
      throw new CapabilityOAuthError("oauth_attempt_raced", "OAuth attempt was already completed", 409);
    }
    return {
      attemptId: attempt.id,
      workspaceId: attempt.workspaceId,
      endpointUrl: attempt.endpointUrl,
      status: "authorized",
      scopes: attempt.scopes,
      connectedAt,
    };
  } catch (error) {
    if (error instanceof CapabilityOAuthError && error.code === "oauth_attempt_raced") throw error;
    const updated = await deps.repository.updateAttempt({
      id: attempt.id,
      workspaceId: attempt.workspaceId,
      expectedStatus: "pending",
      patch: { status: "failed", errorCode: oauthErrorCode(error) },
    });
    if (!updated) {
      throw new CapabilityOAuthError("oauth_attempt_raced", "OAuth attempt was already completed", 409);
    }
    await cleanupSecret(deps.secrets, updated.secretRef);
    if (error instanceof CapabilityOAuthError) throw error;
    throw oauthFailure("oauth_token_exchange_failed", error, 502);
  }
}

/** Poll target for the UI/agent; lazily expires overdue attempts and drops their secrets. */
export async function getOAuthAttemptStatus(
  input: { workspaceId: string; userId: string; attemptId: string },
  overrides?: Partial<OAuthDependencies>,
): Promise<OAuthAttemptStatusResult> {
  const deps = dependencies(overrides);
  await expireAttemptsForWorkspace(input.workspaceId, deps);
  let attempt = await deps.repository.getAttempt({
    workspaceId: input.workspaceId,
    attemptId: input.attemptId,
    createdBy: input.userId,
  });
  if (!attempt) throw new CapabilityOAuthError("oauth_attempt_not_found", "OAuth attempt was not found", 404);
  if ((attempt.status === "pending" || attempt.status === "authorized") && Date.parse(attempt.expiresAt) <= deps.now().getTime()) {
    const expired = await deps.repository.updateAttempt({
      id: attempt.id,
      workspaceId: attempt.workspaceId,
      expectedStatus: attempt.status,
      patch: { status: "expired", errorCode: "oauth_attempt_expired" },
    });
    if (expired) {
      attempt = expired;
      await cleanupSecret(deps.secrets, expired.secretRef);
    } else {
      attempt = await deps.repository.getAttempt({
        workspaceId: input.workspaceId,
        attemptId: input.attemptId,
        createdBy: input.userId,
      }) ?? attempt;
    }
  }
  return publicAttempt(attempt);
}

/** Cancels a pending/authorized attempt and drops its secret; idempotent otherwise. */
export async function cancelOAuthAttempt(
  input: { workspaceId: string; userId: string; attemptId: string },
  overrides?: Partial<OAuthDependencies>,
): Promise<OAuthAttemptStatusResult> {
  const deps = dependencies(overrides);
  const attempt = await deps.repository.getAttempt({
    workspaceId: input.workspaceId,
    attemptId: input.attemptId,
    createdBy: input.userId,
  });
  if (!attempt) throw new CapabilityOAuthError("oauth_attempt_not_found", "OAuth attempt was not found", 404);
  if (attempt.status !== "pending" && attempt.status !== "authorized") return publicAttempt(attempt);
  const updated = await deps.repository.updateAttempt({
    id: attempt.id,
    workspaceId: attempt.workspaceId,
    expectedStatus: attempt.status,
    patch: { status: "cancelled", errorCode: null },
  });
  if (updated) await cleanupSecret(deps.secrets, updated.secretRef);
  return publicAttempt(updated ?? attempt);
}

/**
 * Access token from an `authorized` attempt that has not been attached yet —
 * used by discovery, which runs before a connection exists. Refreshes in
 * place without a lease: an attempt belongs to a single user session.
 */
export async function getOAuthAccessTokenForAttempt(
  input: { workspaceId: string; userId: string; attemptId: string; endpointUrl: string; forceRefresh?: boolean; signal?: AbortSignal },
  overrides?: Partial<OAuthDependencies>,
): Promise<OAuthAccess> {
  const deps = dependencies(overrides);
  const attempt = await deps.repository.getAttempt({
    workspaceId: input.workspaceId,
    attemptId: input.attemptId,
    createdBy: input.userId,
  });
  if (!attempt) throw new CapabilityOAuthError("oauth_attempt_not_found", "OAuth attempt was not found", 404);
  if (canonicalUrl(attempt.endpointUrl) !== canonicalUrl(input.endpointUrl)) {
    throw new CapabilityOAuthError("oauth_endpoint_mismatch", "OAuth authorization belongs to another endpoint", 409);
  }
  if (attempt.status !== "authorized") {
    throw new CapabilityOAuthError("oauth_attempt_not_authorized", "OAuth authorization is not complete", 409);
  }
  let bundle = await readAttemptBundle(attempt, deps.secrets);
  if (!bundle.tokens) throw new CapabilityOAuthError("oauth_tokens_missing", "OAuth tokens are unavailable", 409);
  if (input.forceRefresh || tokensNeedRefresh(bundle.tokens, bundle.tokenExpiresAt ?? null, deps.now())) {
    bundle = await refreshBundle(bundle, attempt.issuer, attempt.resourceUrl, deps, input.signal);
    const secretRef = await deps.secrets.put({
      name: oauthAttemptSecretName(attempt.id),
      plaintext: JSON.stringify(bundle),
    });
    assertVaultRef(secretRef);
    if (secretRef !== attempt.secretRef) {
      await deps.repository.updateAttempt({
        id: attempt.id,
        workspaceId: attempt.workspaceId,
        expectedStatus: "authorized",
        patch: { secretRef },
      });
    }
  }
  if (!bundle.tokens) throw new CapabilityOAuthError("oauth_tokens_missing", "OAuth tokens are unavailable", 409);
  return accessFromBundle(bundle, bundle.tokenExpiresAt ?? null);
}

/**
 * Atomically create the full capability graph and consume its OAuth attempt.
 * The repository implementation is a single PostgreSQL RPC, so an application
 * crash cannot expose an approved connection without its credential. The RPC
 * also returns the existing graph for an equivalent retry after response loss.
 */
export async function registerOAuthCapability(
  input: RegisterOAuthCapabilityInput,
  overrides?: Partial<OAuthDependencies>,
): Promise<RegisterOAuthCapabilityResult> {
  return dependencies(overrides).repository.registerCapability(input);
}

/**
 * Binds an authorized attempt to an existing connection (credential replace
 * flow). Idempotent for the same attempt; a different attempt on a
 * connection that already has credentials is a 409.
 */
export async function attachOAuthCredential(
  input: AttachOAuthCredentialInput,
  overrides?: Partial<OAuthDependencies>,
): Promise<OAuthCredentialRecord> {
  const deps = dependencies(overrides);
  const attempt = await deps.repository.getAttempt({
    workspaceId: input.workspaceId,
    attemptId: input.attemptId,
    createdBy: input.userId,
  });
  if (!attempt) throw new CapabilityOAuthError("oauth_attempt_not_found", "OAuth attempt was not found", 404);
  if (attempt.status !== "authorized") {
    throw new CapabilityOAuthError("oauth_attempt_not_authorized", "OAuth authorization is not complete", 409);
  }
  if (canonicalUrl(attempt.endpointUrl) !== canonicalUrl(input.endpointUrl)) {
    throw new CapabilityOAuthError("oauth_endpoint_mismatch", "OAuth authorization belongs to another endpoint", 409);
  }
  const bundle = await readAttemptBundle(attempt, deps.secrets);
  if (!bundle.tokens) throw new CapabilityOAuthError("oauth_tokens_missing", "OAuth tokens are unavailable", 409);
  const existing = await deps.repository.getCredentialByConnection({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
  });
  if (existing) {
    if (existing.attemptId !== attempt.id) {
      throw new CapabilityOAuthError("oauth_connection_already_attached", "Connection already has OAuth credentials", 409);
    }
    return existing;
  }
  return deps.repository.attachCredential({
    workspaceId: input.workspaceId,
    userId: input.userId,
    connectionId: input.connectionId,
    attemptId: attempt.id,
    capabilityId: input.capabilityId,
    endpointUrl: attempt.endpointUrl,
    tokenExpiresAt: bundle.tokenExpiresAt ?? null,
  });
}

/**
 * Access token for a live connection, refreshing when expired or forced.
 * Only the caller that claims the refresh lease talks to the issuer; others
 * wait for the new revision. A terminal refresh error (invalid grant,
 * client rejected) flips the credential to `needs_reauth` and, when the
 * client itself was rejected, invalidates the shared client registration.
 */
export async function getOAuthAccessTokenForConnection(
  input: { workspaceId: string; connectionId: string; forceRefresh?: boolean; signal?: AbortSignal },
  overrides?: Partial<OAuthDependencies>,
): Promise<OAuthAccess> {
  const deps = dependencies(overrides);
  let credential = await deps.repository.getCredentialByConnection(input);
  if (!credential) throw new CapabilityOAuthError("oauth_credential_not_found", "OAuth credential was not found", 404);
  if (credential.status === "needs_reauth") {
    throw new CapabilityOAuthError("oauth_reauthorization_required", "OAuth provider must be reauthorized", 401);
  }
  if (credential.status === "revoked" || credential.status === "failed") {
    throw new CapabilityOAuthError("oauth_credential_unavailable", "OAuth credential is unavailable", 409);
  }
  let bundle = await readCredentialBundle(credential, deps.secrets);
  if (!bundle.tokens) throw new CapabilityOAuthError("oauth_tokens_missing", "OAuth tokens are unavailable", 409);
  if (!input.forceRefresh && !tokensNeedRefresh(bundle.tokens, credential.tokenExpiresAt, deps.now())) {
    return accessFromBundle(bundle, credential.tokenExpiresAt);
  }

  const leaseId = deps.randomId();
  const leaseUntil = new Date(deps.now().getTime() + REFRESH_LEASE_MS).toISOString();
  const claimed = await deps.repository.claimRefreshLease({
    workspaceId: input.workspaceId,
    credentialId: credential.id,
    expectedRevision: credential.revision,
    leaseId,
    leaseUntil,
    now: deps.now().toISOString(),
  });
  if (!claimed) {
    credential = await waitForRefresh(input.workspaceId, input.connectionId, deps, input.signal);
    if (credential.status === "needs_reauth") {
      throw new CapabilityOAuthError("oauth_reauthorization_required", "OAuth provider must be reauthorized", 401);
    }
    if (credential.status === "revoked" || credential.status === "failed") {
      throw new CapabilityOAuthError("oauth_credential_unavailable", "OAuth credential is unavailable", 409);
    }
    bundle = await readCredentialBundle(credential, deps.secrets);
    if (!bundle.tokens) throw new CapabilityOAuthError("oauth_tokens_missing", "OAuth tokens are unavailable", 409);
    return accessFromBundle(bundle, credential.tokenExpiresAt);
  }

  // Fence the refresh token to the row version that actually owns the lease.
  bundle = await readCredentialBundle(claimed, deps.secrets);
  if (!bundle.tokens) throw new CapabilityOAuthError("oauth_tokens_missing", "OAuth tokens are unavailable", 409);

  let stagedSecretRef: SecretRef | null = null;
  const priorSecretRef = claimed.secretRef;
  try {
    bundle = await refreshBundle(bundle, claimed.issuer, claimed.resourceUrl, deps, input.signal);
    stagedSecretRef = await deps.secrets.put({
      name: oauthCredentialRefreshSecretName(claimed.id, claimed.revision, leaseId),
      plaintext: JSON.stringify(bundle),
    });
    try {
      assertVaultRef(stagedSecretRef);
    } catch (error) {
      await cleanupSecret(deps.secrets, stagedSecretRef);
      throw error;
    }
    const expiresAt = bundle.tokenExpiresAt ?? null;
    const finished = await deps.repository.finishRefresh({
      workspaceId: input.workspaceId,
      credentialId: claimed.id,
      expectedRevision: claimed.revision,
      leaseId,
      status: "active",
      tokenExpiresAt: expiresAt,
      secretRef: stagedSecretRef,
      lastError: null,
    });
    if (!finished) {
      await cleanupSecret(deps.secrets, stagedSecretRef);
      stagedSecretRef = null;
      throw new CapabilityOAuthError("oauth_refresh_lease_lost", "OAuth refresh lease was lost", 409);
    }
    stagedSecretRef = null;
    await cleanupSecret(deps.secrets, priorSecretRef);
    return accessFromBundle(bundle, expiresAt);
  } catch (error) {
    if (stagedSecretRef) await cleanupSecret(deps.secrets, stagedSecretRef);
    const terminal = isTerminalRefreshError(error);
    const finished = await deps.repository.finishRefresh({
      workspaceId: input.workspaceId,
      credentialId: claimed.id,
      expectedRevision: claimed.revision,
      leaseId,
      status: terminal ? "needs_reauth" : "active",
      tokenExpiresAt: claimed.tokenExpiresAt,
      lastError: oauthErrorCode(error),
    });
    if (!finished) {
      throw new CapabilityOAuthError("oauth_refresh_lease_lost", "OAuth refresh lease was lost", 409);
    }
    if (terminal) {
      if (isClientAuthenticationError(error)) {
        await deps.repository.invalidateClient({
          workspaceId: input.workspaceId,
          issuer: claimed.issuer,
        });
      }
      throw new CapabilityOAuthError(
        "oauth_reauthorization_required",
        "OAuth provider must be reauthorized",
        401,
      );
    }
    if (error instanceof CapabilityOAuthError) throw error;
    throw oauthFailure("oauth_refresh_failed", error, 503);
  }
}

function dependencies(overrides?: Partial<OAuthDependencies>): OAuthDependencies {
  return {
    repository: overrides?.repository ?? new SupabaseOAuthRepository(),
    secrets: overrides?.secrets ?? { get: getSecret, put: putNamedSecret, delete: deleteSecret },
    createPinnedFetch: overrides?.createPinnedFetch ?? createPinnedFetch,
    now: overrides?.now ?? (() => new Date()),
    randomState: overrides?.randomState ?? (() => randomBytes(32).toString("base64url")),
    randomId: overrides?.randomId ?? randomUUID,
    wait: overrides?.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

class SupabaseOAuthRepository implements OAuthRepository {
  async isWorkspaceAdmin(input: { workspaceId: string; userId: string }): Promise<boolean> {
    const { data, error } = await getSupabaseAdmin().from("memberships")
      .select("role").eq("workspace_id", input.workspaceId).eq("user_id", input.userId)
      .maybeSingle();
    if (error) throw dbError("oauth_membership_lookup_failed", error);
    return Boolean(data && ["owner", "admin"].includes(String(data.role)));
  }

  async expireAttempts(input: {
    workspaceId: string; now: string; limit: number;
  }): Promise<Array<{ id: string; secretRef: SecretRef }>> {
    const { data, error } = await getSupabaseAdmin().rpc("expire_capability_oauth_attempts", {
      p_workspace_id: input.workspaceId,
      p_now: input.now,
      p_limit: input.limit,
    });
    if (error) throw dbError("oauth_attempt_cleanup_failed", error);
    return ((data ?? []) as Array<Record<string, unknown>>).flatMap((row) =>
      typeof row.attempt_id === "string" && typeof row.secret_ref === "string"
        ? [{ id: row.attempt_id, secretRef: row.secret_ref }]
        : []);
  }

  async findActiveClient(input: { workspaceId: string; issuer: string; redirectUri: string }): Promise<OAuthClientRecord | null> {
    const { data, error } = await getSupabaseAdmin().from("capability_oauth_clients")
      .select(CLIENT_COLUMNS).eq("workspace_id", input.workspaceId).eq("issuer", input.issuer)
      .eq("redirect_uri", input.redirectUri).eq("status", "active").maybeSingle();
    if (error) throw dbError("oauth_client_lookup_failed", error);
    return data ? mapClient(data) : null;
  }

  async createPendingClient(input: { workspaceId: string; issuer: string; redirectUri: string }): Promise<OAuthClientRecord> {
    const sb = getSupabaseAdmin();
    const { data: existing, error: lookupError } = await sb.from("capability_oauth_clients")
      .select("id,status,updated_at").eq("workspace_id", input.workspaceId).eq("issuer", input.issuer)
      .eq("redirect_uri", input.redirectUri).maybeSingle();
    if (lookupError) throw dbError("oauth_client_lookup_failed", lookupError);
    const now = new Date();
    const staleBefore = new Date(now.getTime() - CLIENT_REGISTRATION_LEASE_MS).toISOString();
    if (existing?.status === "pending" && Date.parse(String(existing.updated_at)) > Date.parse(staleBefore)) {
      throw new CapabilityOAuthError("oauth_client_registration_in_progress", "OAuth client registration is already in progress", 409);
    }
    let result;
    if (existing) {
      let query = sb.from("capability_oauth_clients")
        .update({ status: "pending", secret_ref: null, updated_at: now.toISOString() })
        .eq("id", existing.id).eq("workspace_id", input.workspaceId).eq("status", existing.status);
      if (existing.status === "pending") query = query.lte("updated_at", staleBefore);
      result = await query.select(CLIENT_COLUMNS).maybeSingle();
    } else {
      result = await sb.from("capability_oauth_clients").insert({
        workspace_id: input.workspaceId, issuer: input.issuer, redirect_uri: input.redirectUri, status: "pending",
      }).select(CLIENT_COLUMNS).maybeSingle();
    }
    const { data, error } = result;
    if (!data && (!error || (error && typeof error === "object" && "code" in error && error.code === "23505"))) {
      throw new CapabilityOAuthError("oauth_client_registration_in_progress", "OAuth client registration is already in progress", 409);
    }
    if (error || !data) throw dbError("oauth_client_create_failed", error);
    return mapClient(data);
  }

  async activateClient(input: { id: string; workspaceId: string; secretRef: SecretRef }): Promise<OAuthClientRecord> {
    const { data, error } = await getSupabaseAdmin().from("capability_oauth_clients")
      .update({ secret_ref: input.secretRef, status: "active", updated_at: new Date().toISOString() })
      .eq("id", input.id).eq("workspace_id", input.workspaceId).eq("status", "pending")
      .select(CLIENT_COLUMNS).single();
    if (error || !data) throw dbError("oauth_client_activate_failed", error);
    return mapClient(data);
  }

  async failClient(input: { id: string; workspaceId: string; errorCode: string }): Promise<void> {
    const { error } = await getSupabaseAdmin().from("capability_oauth_clients")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", input.id).eq("workspace_id", input.workspaceId).eq("status", "pending");
    if (error) throw dbError("oauth_client_update_failed", error);
  }

  async invalidateClient(input: { workspaceId: string; issuer: string }): Promise<void> {
    const { error } = await getSupabaseAdmin().from("capability_oauth_clients")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("workspace_id", input.workspaceId).eq("issuer", input.issuer).eq("status", "active");
    if (error) throw dbError("oauth_client_invalidate_failed", error);
  }

  async createAttempt(input: Omit<OAuthAttemptRecord, "connectedAt" | "consumedAt" | "capabilityId" | "errorCode">): Promise<OAuthAttemptRecord> {
    const { data, error } = await getSupabaseAdmin().from("capability_oauth_attempts").insert({
      id: input.id, workspace_id: input.workspaceId, requested_by: input.createdBy,
      state_hash: input.stateHash, endpoint_url: input.endpointUrl, allowed_hosts: input.allowedHosts,
      secret_ref: input.secretRef, issuer: input.issuer, resource: input.resourceUrl,
      scopes: input.scopes, status: input.status, expires_at: input.expiresAt,
    }).select(ATTEMPT_COLUMNS).single();
    if (error || !data) throw dbError("oauth_attempt_create_failed", error);
    return mapAttempt(data);
  }

  async getAttemptByStateHash(stateHash: string): Promise<OAuthAttemptRecord | null> {
    const { data, error } = await getSupabaseAdmin().from("capability_oauth_attempts")
      .select(ATTEMPT_COLUMNS).eq("state_hash", stateHash).maybeSingle();
    if (error) throw dbError("oauth_attempt_lookup_failed", error);
    return data ? mapAttempt(data) : null;
  }

  async getAttempt(input: { workspaceId: string; attemptId: string; createdBy?: string }): Promise<OAuthAttemptRecord | null> {
    let query = getSupabaseAdmin().from("capability_oauth_attempts").select(ATTEMPT_COLUMNS)
      .eq("workspace_id", input.workspaceId).eq("id", input.attemptId);
    if (input.createdBy) query = query.eq("requested_by", input.createdBy);
    const { data, error } = await query.maybeSingle();
    if (error) throw dbError("oauth_attempt_lookup_failed", error);
    return data ? mapAttempt(data) : null;
  }

  async updateAttempt(input: {
    id: string; workspaceId: string; expectedStatus?: OAuthAttemptStatus;
    patch: Partial<Pick<OAuthAttemptRecord, "status" | "connectedAt" | "consumedAt" | "capabilityId" | "errorCode" | "secretRef">>;
  }): Promise<OAuthAttemptRecord | null> {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.patch.status !== undefined) patch.status = input.patch.status;
    if (input.patch.connectedAt !== undefined) patch.connected_at = input.patch.connectedAt;
    if (input.patch.consumedAt !== undefined) patch.consumed_at = input.patch.consumedAt;
    if (input.patch.capabilityId !== undefined) patch.capability_id = input.patch.capabilityId;
    if (input.patch.errorCode !== undefined) patch.error_code = input.patch.errorCode;
    if (input.patch.secretRef !== undefined) patch.secret_ref = input.patch.secretRef;
    let query = getSupabaseAdmin().from("capability_oauth_attempts").update(patch)
      .eq("workspace_id", input.workspaceId).eq("id", input.id);
    if (input.expectedStatus) query = query.eq("status", input.expectedStatus);
    const { data, error } = await query.select(ATTEMPT_COLUMNS).maybeSingle();
    if (error) throw dbError("oauth_attempt_update_failed", error);
    return data ? mapAttempt(data) : null;
  }

  async registerCapability(input: RegisterOAuthCapabilityInput): Promise<RegisterOAuthCapabilityResult> {
    const { data, error } = await getSupabaseAdmin().rpc("register_capability_with_oauth", {
      p_workspace_id: input.workspaceId,
      p_user_id: input.userId,
      p_attempt_id: input.attemptId,
      p_expected_endpoint_url: input.expectedEndpointUrl,
      p_key: input.key,
      p_provider: input.provider,
      p_title: input.title,
      p_description: input.description,
      p_provenance: input.provenance,
      p_environment: input.environment,
      p_contract: input.contract,
      p_contract_digest: input.contractDigest,
      p_change_summary: input.changeSummary,
      p_status: input.status,
      p_timeout_ms: input.timeoutMs,
    }).select("capability_id,version_id,connection_id,created").single();
    if (error || !data) {
      const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
      const errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (message.includes("oauth_admin_required")) {
        throw new CapabilityOAuthError("oauth_admin_required", "Workspace admin access is required", 403);
      }
      if (message.includes("oauth_attempt_not_attachable") || message.includes("oauth_attempt_raced")) {
        throw new CapabilityOAuthError("oauth_attempt_not_attachable", "OAuth attempt cannot be registered", 409);
      }
      if (message.includes("oauth_registration_mismatch")) {
        throw new CapabilityOAuthError("oauth_registration_mismatch", "OAuth attempt is already registered differently", 409);
      }
      if (message.includes("oauth_secret_unavailable")) {
        throw new CapabilityOAuthError("oauth_secret_unavailable", "OAuth credential bundle is unavailable", 409);
      }
      if (errorCode === "23505") {
        throw new CapabilityOAuthError("oauth_capability_conflict", "A provider with this key is already registered", 409);
      }
      throw dbError("oauth_capability_register_failed", error);
    }
    return {
      capabilityId: String(data.capability_id),
      versionId: String(data.version_id),
      connectionId: String(data.connection_id),
      created: Boolean(data.created),
    };
  }

  async attachCredential(input: {
    workspaceId: string; userId: string; connectionId: string; attemptId: string;
    capabilityId: string; endpointUrl: string; tokenExpiresAt: string | null;
  }): Promise<OAuthCredentialRecord> {
    const { data, error } = await getSupabaseAdmin().rpc("attach_capability_oauth_credential", {
      p_workspace_id: input.workspaceId,
      p_user_id: input.userId,
      p_attempt_id: input.attemptId,
      p_connection_id: input.connectionId,
      p_capability_id: input.capabilityId,
      p_endpoint_url: input.endpointUrl,
      p_token_expires_at: input.tokenExpiresAt,
    }).select(CREDENTIAL_COLUMNS).single();
    if (error || !data) {
      const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
      if (message.includes("oauth_attempt_not_attachable") || message.includes("oauth_attempt_raced")) {
        throw new CapabilityOAuthError("oauth_attempt_not_attachable", "OAuth attempt cannot be attached", 409);
      }
      if (message.includes("oauth_connection_not_attachable")) {
        throw new CapabilityOAuthError("oauth_connection_not_attachable", "OAuth connection cannot be attached", 409);
      }
      throw dbError("oauth_credential_create_failed", error);
    }
    return mapCredential(data);
  }

  async getCredentialByConnection(input: { workspaceId: string; connectionId: string }): Promise<OAuthCredentialRecord | null> {
    const { data, error } = await getSupabaseAdmin().from("capability_oauth_credentials")
      .select(CREDENTIAL_COLUMNS).eq("workspace_id", input.workspaceId)
      .eq("connection_id", input.connectionId).maybeSingle();
    if (error) throw dbError("oauth_credential_lookup_failed", error);
    return data ? mapCredential(data) : null;
  }

  async claimRefreshLease(input: {
    workspaceId: string; credentialId: string; expectedRevision: number; leaseId: string; leaseUntil: string; now: string;
  }): Promise<OAuthCredentialRecord | null> {
    const sb = getSupabaseAdmin();
    const patch = { status: "refreshing", refresh_lease_token: input.leaseId, refresh_lease_until: input.leaseUntil, updated_at: input.now };
    let result = await sb.from("capability_oauth_credentials").update(patch)
      .eq("workspace_id", input.workspaceId).eq("id", input.credentialId)
      .eq("revision", input.expectedRevision).eq("status", "active")
      .select(CREDENTIAL_COLUMNS).maybeSingle();
    if (result.error) throw dbError("oauth_refresh_claim_failed", result.error);
    if (!result.data) {
      result = await sb.from("capability_oauth_credentials").update(patch)
        .eq("workspace_id", input.workspaceId).eq("id", input.credentialId).eq("status", "refreshing")
        .eq("revision", input.expectedRevision).lt("refresh_lease_until", input.now)
        .select(CREDENTIAL_COLUMNS).maybeSingle();
      if (result.error) throw dbError("oauth_refresh_claim_failed", result.error);
    }
    return result.data ? mapCredential(result.data) : null;
  }

  async finishRefresh(input: {
    workspaceId: string; credentialId: string; expectedRevision: number; leaseId: string; status: OAuthCredentialStatus;
    tokenExpiresAt: string | null; secretRef?: SecretRef; lastError?: string | null;
  }): Promise<OAuthCredentialRecord | null> {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      status: input.status, token_expires_at: input.tokenExpiresAt, refresh_lease_token: null,
      refresh_lease_until: null, revision: input.expectedRevision + 1,
      last_error: input.lastError ?? null, updated_at: now,
    };
    if (input.secretRef !== undefined) {
      patch.secret_ref = input.secretRef;
      if (input.status === "active") patch.last_refreshed_at = now;
    }
    const { data, error } = await getSupabaseAdmin().from("capability_oauth_credentials").update(patch)
      .eq("workspace_id", input.workspaceId).eq("id", input.credentialId)
      .eq("revision", input.expectedRevision).eq("refresh_lease_token", input.leaseId)
      .select(CREDENTIAL_COLUMNS).maybeSingle();
    if (error) throw dbError("oauth_refresh_finish_failed", error);
    return data ? mapCredential(data) : null;
  }
}

const CLIENT_COLUMNS = "id,workspace_id,issuer,redirect_uri,secret_ref,status,updated_at";
const ATTEMPT_COLUMNS = "id,workspace_id,requested_by,state_hash,endpoint_url,allowed_hosts,secret_ref,issuer,resource,scopes,status,error_code,expires_at,connected_at,consumed_at,capability_id";
const CREDENTIAL_COLUMNS = "id,workspace_id,connection_id,attempt_id,secret_ref,issuer,resource,scopes,token_expires_at,status,refresh_lease_token,refresh_lease_until,revision";

function mapClient(row: Record<string, unknown>): OAuthClientRecord {
  return { id: String(row.id), workspaceId: String(row.workspace_id), issuer: String(row.issuer),
    redirectUri: String(row.redirect_uri), secretRef: typeof row.secret_ref === "string" ? row.secret_ref : null,
    status: row.status as OAuthClientStatus, updatedAt: String(row.updated_at) };
}

function mapAttempt(row: Record<string, unknown>): OAuthAttemptRecord {
  return { id: String(row.id), workspaceId: String(row.workspace_id), createdBy: String(row.requested_by),
    stateHash: String(row.state_hash), endpointUrl: String(row.endpoint_url), allowedHosts: stringArray(row.allowed_hosts),
    secretRef: String(row.secret_ref), issuer: String(row.issuer), resourceUrl: String(row.resource),
    scopes: stringArray(row.scopes), status: row.status as OAuthAttemptStatus,
    errorCode: typeof row.error_code === "string" ? row.error_code : null, expiresAt: String(row.expires_at),
    connectedAt: typeof row.connected_at === "string" ? row.connected_at : null,
    consumedAt: typeof row.consumed_at === "string" ? row.consumed_at : null,
    capabilityId: typeof row.capability_id === "string" ? row.capability_id : null };
}

function mapCredential(row: Record<string, unknown>): OAuthCredentialRecord {
  return { id: String(row.id), workspaceId: String(row.workspace_id), connectionId: String(row.connection_id),
    attemptId: String(row.attempt_id), secretRef: String(row.secret_ref), issuer: String(row.issuer),
    resourceUrl: String(row.resource), scopes: stringArray(row.scopes),
    tokenExpiresAt: typeof row.token_expires_at === "string" ? row.token_expires_at : null,
    status: row.status as OAuthCredentialStatus,
    refreshLeaseToken: typeof row.refresh_lease_token === "string" ? row.refresh_lease_token : null,
    refreshLeaseUntil: typeof row.refresh_lease_until === "string" ? row.refresh_lease_until : null,
    revision: Number(row.revision ?? 0) };
}

async function requestOAuthChallenge(endpoint: URL, fetchFn: FetchLike): Promise<{
  resourceMetadataUrl?: URL;
  scope?: string;
}> {
  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "bcontext-oauth-discovery", version: "0.1.0" },
      },
    }),
  });
  const challenge = extractWWWAuthenticateParams(response);
  await response.body?.cancel();
  if (response.status !== 401 && !challenge.resourceMetadataUrl) {
    throw new CapabilityOAuthError(
      response.ok ? "oauth_not_required" : "oauth_challenge_missing",
      response.ok ? "The MCP server did not request OAuth" : "The MCP server did not advertise OAuth metadata",
      response.ok ? 409 : 502,
    );
  }
  return { resourceMetadataUrl: challenge.resourceMetadataUrl, scope: challenge.scope };
}

function validateEndpoint(value: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new CapabilityOAuthError("oauth_endpoint_invalid", "OAuth endpoint URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new CapabilityOAuthError("oauth_endpoint_invalid", "OAuth endpoint must be an HTTPS URL without credentials or fragments");
  }
  if (!hostAllowed(url.hostname, allowedHosts)) {
    throw new CapabilityOAuthError("oauth_endpoint_host_not_allowed", "OAuth endpoint host is not allowlisted");
  }
  return url;
}

function validateResource(endpoint: URL, metadata: OAuthProtectedResourceMetadata): URL {
  const resource = new URL(metadata.resource);
  if (resource.protocol !== "https:" || resource.username || resource.password || resource.hash) {
    throw new CapabilityOAuthError("oauth_resource_invalid", "OAuth resource identifier is invalid", 502);
  }
  if (!checkResourceAllowed({ requestedResource: endpoint, configuredResource: resource })) {
    throw new CapabilityOAuthError("oauth_resource_mismatch", "OAuth resource does not match the MCP endpoint", 502);
  }
  // The SDK intentionally permits a broader path resource (for example
  // `https://host/` for `https://host/mcp`). Query-bound endpoints are
  // different: project_ref/read_only and similar selectors are part of the
  // audience, so the protected resource must preserve them exactly.
  if (endpoint.search && canonicalQuery(resource) !== canonicalQuery(endpoint)) {
    throw new CapabilityOAuthError("oauth_resource_mismatch", "OAuth resource does not match the MCP endpoint", 502);
  }
  return resource;
}

function selectIssuer(metadata: OAuthProtectedResourceMetadata): URL {
  const value = metadata.authorization_servers?.[0];
  if (!value) throw new CapabilityOAuthError("oauth_issuer_missing", "OAuth resource has no authorization server", 502);
  const issuer = new URL(value);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.hash) {
    throw new CapabilityOAuthError("oauth_issuer_invalid", "OAuth authorization server is invalid", 502);
  }
  return issuer;
}

async function validateAuthorizationMetadata(
  issuer: URL,
  metadata: AuthorizationServerMetadata,
): Promise<string[]> {
  if (canonicalIssuer(metadata.issuer) !== canonicalIssuer(issuer.href)) {
    throw new CapabilityOAuthError("oauth_issuer_mismatch", "OAuth metadata issuer does not match", 502);
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new CapabilityOAuthError("oauth_pkce_s256_required", "OAuth server must advertise PKCE S256", 502);
  }
  if (!metadata.response_types_supported.includes("code")) {
    throw new CapabilityOAuthError("oauth_code_flow_unsupported", "OAuth server does not support authorization code flow", 502);
  }
  if (!metadata.registration_endpoint) {
    throw new CapabilityOAuthError("oauth_registration_unsupported", "OAuth server does not support dynamic client registration", 502);
  }
  const endpoints = [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]
    .map((value) => new URL(value));
  for (const endpoint of endpoints) {
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
      throw new CapabilityOAuthError("oauth_metadata_endpoint_invalid", "OAuth metadata contains an unsafe endpoint", 502);
    }
    // Keep codes, client secrets and refresh tokens on the discovered issuer.
    if (endpoint.origin !== issuer.origin) {
      throw new CapabilityOAuthError("oauth_metadata_cross_origin", "OAuth server endpoints must share the issuer origin", 502);
    }
    await resolveSafeTarget(endpoint, [endpoint.hostname]);
  }
  return normalizedHosts(endpoints.map((endpoint) => endpoint.hostname));
}

function clientMetadata(
  name: string | undefined,
  redirectUri: string,
  metadata: AuthorizationServerMetadata,
): OAuthClientMetadata {
  const supported = metadata.token_endpoint_auth_methods_supported ?? [];
  const method = supported.length === 0 || supported.includes("client_secret_basic")
    ? "client_secret_basic"
    : supported.includes("client_secret_post")
      ? "client_secret_post"
      : supported.includes("none")
        ? "none"
        : null;
  if (!method) {
    throw new CapabilityOAuthError("oauth_client_auth_unsupported", "OAuth token endpoint authentication is unsupported", 502);
  }
  return {
    client_name: name?.trim().slice(0, 100) || "Bcontext Tools",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
  };
}

async function registerManagedOAuthClient(
  input: {
    workspaceId: string;
    issuer: URL;
    redirectUri: string;
    metadata: AuthorizationServerMetadata;
    clientName: string | undefined;
    scope: string | undefined;
    oauthFetch: FetchLike;
    discoveryState: OAuthDiscoveryState;
    oauthHosts: string[];
  },
  deps: OAuthDependencies,
): Promise<{ record: OAuthClientRecord; bundle: ClientSecretBundle }> {
  const pending = await deps.repository.createPendingClient({
    workspaceId: input.workspaceId,
    issuer: input.issuer.href,
    redirectUri: input.redirectUri,
  });
  try {
    const clientInformation = await registerClient(input.issuer, {
      metadata: input.metadata,
      clientMetadata: clientMetadata(input.clientName, input.redirectUri, input.metadata),
      scope: input.scope,
      fetchFn: input.oauthFetch,
    });
    const bundle: ClientSecretBundle = {
      clientInformation,
      discoveryState: input.discoveryState,
      oauthHosts: input.oauthHosts,
    };
    const secretRef = await deps.secrets.put({
      name: oauthClientSecretName(pending.id),
      plaintext: JSON.stringify(bundle),
    });
    assertVaultRef(secretRef);
    const record = await deps.repository.activateClient({
      id: pending.id,
      workspaceId: input.workspaceId,
      secretRef,
    });
    return { record, bundle };
  } catch (error) {
    await deps.repository.failClient({
      id: pending.id,
      workspaceId: input.workspaceId,
      errorCode: oauthErrorCode(error),
    });
    throw oauthFailure("oauth_client_registration_failed", error, 502);
  }
}

function clientRecordReusable(
  record: OAuthClientRecord,
  client: OAuthClientInformationMixed,
  now: Date,
): boolean {
  const updatedAt = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAt) || now.getTime() - updatedAt > OAUTH_CLIENT_REUSE_TTL_MS) return false;
  const expiresAt = client.client_secret_expires_at;
  return !(typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0
    && expiresAt * 1000 <= now.getTime());
}

function authorizationProbeUrl(
  authorizationUrl: URL,
  randomState: () => string,
): URL {
  const probeUrl = new URL(authorizationUrl);
  const probeVerifier = randomState();
  probeUrl.searchParams.set("state", randomState());
  probeUrl.searchParams.set(
    "code_challenge",
    createHash("sha256").update(probeVerifier, "utf8").digest("base64url"),
  );
  return probeUrl;
}

async function authorizationRejectsClient(
  authorizationUrl: URL,
  fetchFn: FetchLike,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetchFn(authorizationUrl, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch {
    // Validation is a recovery aid, not a new availability dependency. The
    // user's browser may still reach an authorization server that this probe
    // could not, so keep the standards-compliant URL when validation fails.
    return false;
  }
  if (![400, 401, 403].includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    return false;
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    await response.body?.cancel().catch(() => {});
    return false;
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const error = typeof payload.error === "string" ? payload.error.trim().toLowerCase() : "";
  const description = typeof payload.error_description === "string" ? payload.error_description.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const detail = [description, message].filter(Boolean).join("\n");
  return error === "invalid_client"
    || error === "unauthorized_client"
    || /(?:^|\b)unrecognized client_id(?:\b|$)/i.test(detail)
    || /^client_id:\s*invalid\b/i.test(detail);
}

function selectScopes(challengeScope: string | undefined, metadata: OAuthProtectedResourceMetadata): string[] {
  const values = challengeScope ? challengeScope.split(/\s+/) : (metadata.scopes_supported ?? []);
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 100);
}

function oauthCallbackUrl(appOrigin: string): string {
  let value: URL;
  try { value = new URL(appOrigin); }
  catch { throw new CapabilityOAuthError("oauth_app_origin_invalid", "Application origin is invalid", 500); }
  const localhost = value.hostname === "localhost" || value.hostname === "127.0.0.1" || value.hostname === "::1";
  if ((!localhost && value.protocol !== "https:") || (localhost && !["http:", "https:"].includes(value.protocol))) {
    throw new CapabilityOAuthError("oauth_app_origin_invalid", "Application origin must use HTTPS", 500);
  }
  if (value.username || value.password) throw new CapabilityOAuthError("oauth_app_origin_invalid", "Application origin is invalid", 500);
  return new URL(CALLBACK_PATH, value.origin).href;
}

async function readClientBundle(record: OAuthClientRecord, store: OAuthSecretStore): Promise<ClientSecretBundle> {
  const raw = await store.get(record.secretRef);
  const parsed = parseBundle(raw);
  if (!isClientInformation(parsed.clientInformation) || !isDiscoveryState(parsed.discoveryState) || !Array.isArray(parsed.oauthHosts)) {
    throw new CapabilityOAuthError("oauth_client_secret_invalid", "OAuth client information is unavailable", 409);
  }
  return parsed as unknown as ClientSecretBundle;
}

async function readAttemptBundle(record: OAuthAttemptRecord, store: OAuthSecretStore): Promise<AttemptSecretBundle> {
  return validateAttemptBundle(await store.get(record.secretRef));
}

async function readCredentialBundle(record: OAuthCredentialRecord, store: OAuthSecretStore): Promise<AttemptSecretBundle> {
  return validateAttemptBundle(await store.get(record.secretRef));
}

function validateAttemptBundle(raw: string | null): AttemptSecretBundle {
  const parsed = parseBundle(raw);
  if (!isClientInformation(parsed.clientInformation) || !isDiscoveryState(parsed.discoveryState) || !Array.isArray(parsed.oauthHosts)) {
    throw new CapabilityOAuthError("oauth_secret_invalid", "OAuth credential bundle is unavailable", 409);
  }
  return parsed as unknown as AttemptSecretBundle;
}

function parseBundle(raw: string | null): Record<string, unknown> {
  if (!raw) throw new CapabilityOAuthError("oauth_secret_unavailable", "OAuth credential bundle is unavailable", 409);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* handled below */ }
  throw new CapabilityOAuthError("oauth_secret_invalid", "OAuth credential bundle is invalid", 409);
}

function isClientInformation(value: unknown): value is OAuthClientInformationMixed {
  return Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>).client_id === "string");
}

function isDiscoveryState(value: unknown): value is OAuthDiscoveryState {
  return Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>).authorizationServerUrl === "string");
}

async function refreshBundle(
  bundle: AttemptSecretBundle,
  issuerValue: string,
  resourceValue: string,
  deps: OAuthDependencies,
  signal?: AbortSignal,
): Promise<AttemptSecretBundle> {
  const refreshToken = bundle.tokens?.refresh_token;
  if (!refreshToken) {
    throw new CapabilityOAuthError("oauth_refresh_token_missing", "OAuth provider must be reauthorized", 401);
  }
  const metadata = bundle.discoveryState.authorizationServerMetadata;
  if (!metadata) throw new CapabilityOAuthError("oauth_server_metadata_missing", "OAuth server metadata is unavailable", 409);
  const tokens = await refreshAuthorization(new URL(issuerValue), {
    metadata,
    clientInformation: bundle.clientInformation,
    refreshToken,
    resource: new URL(resourceValue),
    fetchFn: withFetchTimeout(
      deps.createPinnedFetch(bundle.oauthHosts),
      REFRESH_HTTP_TIMEOUT_MS,
      { signal },
    ),
  });
  assertBearerTokens(tokens);
  return { ...bundle, codeVerifier: undefined, tokens, tokenExpiresAt: tokenExpiry(tokens, deps.now()) };
}

function withFetchTimeout(
  fetchFn: FetchLike,
  timeoutMs: number,
  options: { deadlineMs?: number; signal?: AbortSignal; maxBytes?: number } = {},
): FetchLike {
  return async (url, init) => {
    const remainingMs = options.deadlineMs === undefined
      ? timeoutMs
      : Math.min(timeoutMs, options.deadlineMs - Date.now());
    if (remainingMs <= 0) {
      throw new CapabilityOAuthError("oauth_flow_timeout", "OAuth provider request timed out", 504);
    }
    const controller = new AbortController();
    const signals = [options.signal, init?.signal].filter((signal): signal is AbortSignal => Boolean(signal));
    const forwardAbort = () => {
      const source = signals.find((signal) => signal.aborted);
      controller.abort(source?.reason);
    };
    for (const signal of signals) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const signal of signals) signal.removeEventListener("abort", forwardAbort);
    };
    const timeout = setTimeout(
      () => controller.abort(new DOMException("OAuth provider request timed out", "TimeoutError")),
      remainingMs,
    );
    try {
      const response = await fetchFn(url, { ...init, signal: controller.signal });
      const maxBytes = options.maxBytes ?? OAUTH_MAX_RESPONSE_BYTES;
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        cleanup();
        controller.abort(new DOMException("OAuth provider response is too large", "QuotaExceededError"));
        await response.body?.cancel().catch(() => {});
        throw new CapabilityOAuthError(
          "oauth_response_too_large",
          "OAuth provider response exceeded the size limit",
          502,
        );
      }
      if (!response.body) {
        cleanup();
        return response;
      }
      const reader = response.body.getReader();
      let receivedBytes = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              cleanup();
              streamController.close();
            } else {
              receivedBytes += chunk.value.byteLength;
              if (receivedBytes > maxBytes) {
                cleanup();
                controller.abort(new DOMException("OAuth provider response is too large", "QuotaExceededError"));
                await reader.cancel().catch(() => {});
                streamController.error(new CapabilityOAuthError(
                  "oauth_response_too_large",
                  "OAuth provider response exceeded the size limit",
                  502,
                ));
                return;
              }
              streamController.enqueue(chunk.value);
            }
          } catch (error) {
            cleanup();
            streamController.error(error);
          }
        },
        async cancel(reason) {
          cleanup();
          await reader.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}

function accessFromBundle(bundle: AttemptSecretBundle, expiresAt: string | null): OAuthAccess {
  if (!bundle.tokens) throw new CapabilityOAuthError("oauth_tokens_missing", "OAuth tokens are unavailable", 409);
  assertBearerTokens(bundle.tokens);
  return { accessToken: bundle.tokens.access_token, tokenType: bundle.tokens.token_type, expiresAt, oauthHosts: bundle.oauthHosts };
}

function assertBearerTokens(tokens: OAuthTokens): void {
  if (tokens.token_type.toLowerCase() !== "bearer" || !tokens.access_token) {
    throw new CapabilityOAuthError("oauth_token_type_unsupported", "OAuth provider did not issue a Bearer token", 502);
  }
}

function tokensNeedRefresh(tokens: OAuthTokens, expiresAt: string | null, now: Date): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) <= now.getTime() + REFRESH_SKEW_MS || !tokens.access_token;
}

function tokenExpiry(tokens: OAuthTokens, issuedAt: Date): string | null {
  return typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
    ? new Date(issuedAt.getTime() + Math.max(0, tokens.expires_in) * 1000).toISOString()
    : null;
}

async function waitForRefresh(
  workspaceId: string,
  connectionId: string,
  deps: OAuthDependencies,
  signal?: AbortSignal,
): Promise<OAuthCredentialRecord> {
  const deadline = deps.now().getTime() + MAX_REFRESH_WAIT_MS;
  do {
    throwIfAborted(signal);
    await deps.wait(100);
    throwIfAborted(signal);
    const value = await deps.repository.getCredentialByConnection({ workspaceId, connectionId });
    if (!value) throw new CapabilityOAuthError("oauth_credential_not_found", "OAuth credential was not found", 404);
    if (value.status !== "refreshing") return value;
  } while (deps.now().getTime() < deadline);
  throw new CapabilityOAuthError("oauth_refresh_in_progress", "OAuth credential is still refreshing", 409);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("OAuth request aborted", "AbortError");
}

async function expireAttemptsForWorkspace(
  workspaceId: string,
  deps: OAuthDependencies,
  requestedLimit = 100,
): Promise<number> {
  const limit = Math.min(100, Math.max(1, Math.trunc(requestedLimit)));
  const expired = await deps.repository.expireAttempts({
    workspaceId,
    now: deps.now().toISOString(),
    limit,
  });
  // Production deletes these refs atomically inside the RPC. Keeping this
  // idempotent pass makes alternate repositories and tests obey the same
  // secret-lifecycle contract.
  await Promise.all(expired.map((attempt) => cleanupSecret(deps.secrets, attempt.secretRef)));
  return expired.length;
}

function publicAttempt(attempt: OAuthAttemptRecord): OAuthAttemptStatusResult {
  return { id: attempt.id, status: attempt.status, endpointUrl: attempt.endpointUrl, scopes: attempt.scopes,
    expiresAt: attempt.expiresAt, connectedAt: attempt.connectedAt, errorCode: attempt.errorCode };
}

function hashState(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function oauthClientSecretName(id: string): string { return `capability-oauth:client:${id}`; }
function oauthAttemptSecretName(id: string): string { return `capability-oauth:attempt:${id}`; }
function oauthCredentialRefreshSecretName(id: string, revision: number, leaseId: string): string {
  return `capability-oauth:credential:${id}:r${revision + 1}:${leaseId}`;
}

function assertVaultRef(ref: string): void {
  if (!/^vault:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref)) {
    throw new CapabilityOAuthError("oauth_vault_required", "OAuth secrets require Supabase Vault", 503);
  }
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const value = normalizeHost(hostname);
  return allowedHosts.some((host) => normalizeHost(host) === value);
}

function normalizedHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map(normalizeHost))];
}

function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function canonicalQuery(value: URL): string {
  return [...value.searchParams.entries()]
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
    .map(([key, item]) => `${encodeURIComponent(key)}=${encodeURIComponent(item)}`)
    .join("&");
}

function canonicalIssuer(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/$/, "");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function safeProviderError(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80);
  return `oauth_provider_${safe || "error"}`;
}

function oauthErrorCode(error: unknown): string {
  if (error instanceof CapabilityOAuthError) return error.code;
  const candidate = error && typeof error === "object" && "errorCode" in error
    ? String((error as { errorCode?: unknown }).errorCode)
    : error && typeof error === "object" && "error" in error
      ? String((error as { error?: unknown }).error)
      : "error";
  return safeProviderError(candidate);
}

function isTerminalRefreshError(error: unknown): boolean {
  if (error instanceof CapabilityOAuthError) {
    return error.code === "oauth_refresh_token_missing" || error.code === "oauth_reauthorization_required";
  }
  const code = error && typeof error === "object" && "errorCode" in error
    ? String((error as { errorCode?: unknown }).errorCode)
    : error && typeof error === "object" && "error" in error
      ? String((error as { error?: unknown }).error)
      : "";
  return ["invalid_grant", "invalid_client", "unauthorized_client"].includes(code);
}

function isClientAuthenticationError(error: unknown): boolean {
  const code = error && typeof error === "object" && "errorCode" in error
    ? String((error as { errorCode?: unknown }).errorCode)
    : error && typeof error === "object" && "error" in error
      ? String((error as { error?: unknown }).error)
      : "";
  return code === "invalid_client" || code === "unauthorized_client";
}

async function cleanupSecret(store: OAuthSecretStore, ref: SecretRef): Promise<void> {
  if (!store.delete) return;
  try { await store.delete(ref); }
  catch { /* best-effort cleanup; the DB lifecycle remains authoritative */ }
}

function oauthFailure(code: string, error: unknown, status: number): CapabilityOAuthError {
  if (error instanceof CapabilityOAuthError) return error;
  return new CapabilityOAuthError(code, safeErrorMessage(error), status);
}

function safeErrorMessage(error: unknown): string {
  const fallback = "OAuth provider request failed";
  if (!(error instanceof Error)) return fallback;
  return error.message
    .replace(/(access|refresh|client)[_-]?token["'=:\s]+[^\s"']+/gi, "$1_token [redacted]")
    .replace(/client_secret["'=:\s]+[^\s"']+/gi, "client_secret [redacted]")
    .slice(0, 240) || fallback;
}

function dbError(code: string, error: unknown): CapabilityOAuthError {
  const message = error && typeof error === "object" && "message" in error
    ? String((error as { message?: unknown }).message).slice(0, 180)
    : "OAuth persistence failed";
  return new CapabilityOAuthError(code, message, 500);
}
