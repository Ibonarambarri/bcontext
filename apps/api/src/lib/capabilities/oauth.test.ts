import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  attachOAuthCredential,
  cancelOAuthAttempt,
  completeOAuthAuthorization,
  getOAuthAccessTokenForConnection,
  getOAuthAttemptStatus,
  ManagedOAuthClientProvider,
  registerOAuthCapability,
  startOAuthAuthorization,
  type OAuthAttemptRecord,
  type OAuthClientRecord,
  type OAuthCredentialRecord,
  type OAuthDependencies,
  type OAuthRepository,
  type OAuthSecretStore,
  type RegisterOAuthCapabilityInput,
} from "./oauth";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";
const capabilityId = "55555555-5555-4555-8555-555555555555";

describe("ManagedOAuthClientProvider", () => {
  it("persists SDK state without navigating or exposing tokens", async () => {
    const saved: string[] = [];
    const provider = new ManagedOAuthClientProvider({
      redirectUrl: "https://app.example.com/api/capabilities/oauth/callback",
      clientMetadata: { redirect_uris: ["https://app.example.com/api/capabilities/oauth/callback"] },
      state: "state-value",
    }, {
      codeVerifier: async (value) => { saved.push(value); },
    });
    await provider.saveCodeVerifier("verifier");
    provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
    expect(provider.state()).toBe("state-value");
    expect(provider.codeVerifier()).toBe("verifier");
    expect(saved).toEqual(["verifier"]);
    expect(provider.authorizationUrl?.href).toBe("https://auth.example.com/authorize");
  });
});

describe("managed MCP OAuth", () => {
  it("runs DCR + PKCE, binds callback ownership and refreshes under a lease", async () => {
    const repository = new MemoryRepository();
    const secrets = new MemorySecrets();
    let now = new Date("2026-07-17T00:00:00.000Z");
    const staleAttemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const staleSecretRef = await secrets.put({
      name: "stale-attempt",
      plaintext: "stale-sensitive-value",
    });
    repository.attempts.set(staleAttemptId, {
      id: staleAttemptId,
      workspaceId,
      createdBy: userId,
      endpointUrl: "https://8.8.8.8/old-mcp",
      allowedHosts: ["8.8.8.8"],
      issuer: "https://8.8.4.4/",
      resourceUrl: "https://8.8.8.8/",
      scopes: [],
      stateHash: createHash("sha256").update("stale-state").digest("hex"),
      secretRef: staleSecretRef,
      status: "pending",
      expiresAt: "2026-07-16T23:59:00.000Z",
      connectedAt: null,
      consumedAt: null,
      capabilityId: null,
      errorCode: null,
    });
    const calls: Array<{ url: string; body: string }> = [];
    const fetchFn: FetchLike = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
      calls.push({ url, body });
      if (url === "https://8.8.8.8/mcp?read_only=true") {
        return new Response(JSON.stringify({ message: "Unauthorized" }), {
          status: 401,
          headers: {
            "www-authenticate": "Bearer resource_metadata=\"https://8.8.8.8/.well-known/oauth-protected-resource/mcp?read_only=true\"",
          },
        });
      }
      if (url === "https://8.8.8.8/.well-known/oauth-protected-resource/mcp?read_only=true") {
        return json({
          resource: "https://8.8.8.8/mcp?read_only=true",
          authorization_servers: ["https://8.8.4.4"],
          scopes_supported: ["database:read", "projects:read"],
        });
      }
      if (url === "https://8.8.4.4/.well-known/oauth-authorization-server") {
        return json({
          issuer: "https://8.8.4.4",
          authorization_endpoint: "https://8.8.4.4/authorize",
          token_endpoint: "https://8.8.4.4/token",
          registration_endpoint: "https://8.8.4.4/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url === "https://8.8.4.4/register") {
        return json({
          client_id: "dcr-client",
          client_secret: "dcr-secret",
          redirect_uris: ["https://app.example.com/api/capabilities/oauth/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_basic",
        }, 201);
      }
      if (url === "https://8.8.4.4/token") {
        const grant = new URLSearchParams(body).get("grant_type");
        return json(grant === "refresh_token"
          ? { access_token: "access-two", refresh_token: "refresh-two", token_type: "Bearer", expires_in: 3600 }
          : { access_token: "access-one", refresh_token: "refresh-one", token_type: "Bearer", expires_in: 3600 });
      }
      return new Response("not found", { status: 404 });
    };
    const deps: Partial<OAuthDependencies> = {
      repository,
      secrets,
      createPinnedFetch: () => fetchFn,
      now: () => now,
      randomState: () => "raw-state-never-persisted",
      randomId: () => attemptId,
      wait: async () => {},
    };

    const started = await startOAuthAuthorization({
      workspaceId,
      userId,
      endpointUrl: "https://8.8.8.8/mcp?read_only=true",
      allowedHosts: ["8.8.8.8"],
      appOrigin: "https://app.example.com",
    }, deps);
    expect(started.attemptId).toBe(attemptId);
    expect(repository.attempts.get(staleAttemptId)).toMatchObject({
      status: "expired",
      errorCode: "oauth_attempt_expired",
    });
    expect(await secrets.get(staleSecretRef)).toBeNull();
    const authorize = new URL(started.authorizationUrl);
    expect(authorize.searchParams.get("state")).toBe("raw-state-never-persisted");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("resource")).toBe("https://8.8.8.8/mcp?read_only=true");
    expect(repository.attempts.get(attemptId)?.stateHash).toBe(
      createHash("sha256").update("raw-state-never-persisted").digest("hex"),
    );
    expect(JSON.stringify([...repository.attempts.values()])).not.toContain("raw-state-never-persisted");

    await expect(completeOAuthAuthorization({
      userId: "99999999-9999-4999-8999-999999999999",
      state: "raw-state-never-persisted",
      code: "code-one",
      appOrigin: "https://app.example.com",
    }, deps)).rejects.toMatchObject({ code: "oauth_state_invalid" });
    expect(calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(0);

    const completed = await completeOAuthAuthorization({
      userId,
      state: "raw-state-never-persisted",
      code: "code-one",
      appOrigin: "https://app.example.com",
    }, deps);
    expect(completed.status).toBe("authorized");
    expect(new URLSearchParams(calls.find((call) => call.url.endsWith("/token"))!.body).get("resource"))
      .toBe("https://8.8.8.8/mcp?read_only=true");
    const stored = JSON.parse(await secrets.get(repository.attempts.get(attemptId)!.secretRef) ?? "{}") as Record<string, unknown>;
    expect(stored).not.toHaveProperty("codeVerifier");
    expect(stored).toHaveProperty("tokens.access_token", "access-one");

    const credential = await attachOAuthCredential({
      workspaceId,
      userId,
      attemptId,
      connectionId,
      capabilityId,
      endpointUrl: "https://8.8.8.8/mcp?read_only=true",
    }, deps);
    const previousSecretRef = credential.secretRef;
    now = new Date("2026-07-17T02:00:00.000Z");
    const access = await getOAuthAccessTokenForConnection({ workspaceId, connectionId }, deps);
    expect(access.accessToken).toBe("access-two");
    expect(repository.credentials.get(connectionId)).toMatchObject({ status: "active", revision: 2 });
    expect(repository.credentials.get(connectionId)?.secretRef).not.toBe(previousSecretRef);
    expect(await secrets.get(previousSecretRef)).toBeNull();

    await expect(getOAuthAccessTokenForConnection(
      { workspaceId, connectionId, forceRefresh: true },
      {
        ...deps,
        createPinnedFetch: () => async () => json({ error: "temporarily_unavailable" }, 503),
      },
    )).rejects.toMatchObject({ code: "oauth_refresh_failed", httpStatus: 503 });
    expect(repository.credentials.get(connectionId)?.status).toBe("active");

    await expect(getOAuthAccessTokenForConnection(
      { workspaceId, connectionId, forceRefresh: true },
      {
        ...deps,
        createPinnedFetch: () => async () => json({
          error: "invalid_client",
          error_description: "client registration was revoked",
        }, 401),
      },
    )).rejects.toMatchObject({ code: "oauth_reauthorization_required", httpStatus: 401 });
    expect(repository.credentials.get(connectionId)?.status).toBe("needs_reauth");
    expect([...repository.clients.values()].find((client) => client.issuer === "https://8.8.4.4/")?.status)
      .toBe("failed");
  });

  it("re-registers a cached DCR client rejected by the authorization endpoint", async () => {
    const repository = new MemoryRepository();
    const secrets = new MemorySecrets();
    const clientId = "66666666-6666-4666-8666-666666666666";
    const clientSecretRef = await secrets.put({
      name: "cached-client",
      plaintext: JSON.stringify({
        clientInformation: {
          client_id: "revoked-client",
          client_secret: "revoked-secret",
          redirect_uris: ["https://app.example.com/api/capabilities/oauth/callback"],
        },
        discoveryState: { authorizationServerUrl: "https://8.8.4.4/" },
        oauthHosts: ["8.8.4.4"],
      }),
    });
    repository.clients.set(clientId, {
      id: clientId,
      workspaceId,
      issuer: "https://8.8.4.4/",
      redirectUri: "https://app.example.com/api/capabilities/oauth/callback",
      secretRef: clientSecretRef,
      status: "active",
      updatedAt: "2026-07-17T08:29:00.000Z",
    });
    let registrations = 0;
    let cachedClientProbes = 0;
    let probeState: string | null = null;
    let probeChallenge: string | null = null;
    const fetchFn: FetchLike = async (input) => {
      const url = new URL(String(input));
      if (url.href === "https://8.8.8.8/mcp") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": "Bearer resource_metadata=\"https://8.8.8.8/.well-known/oauth-protected-resource/mcp\"",
          },
        });
      }
      if (url.href === "https://8.8.8.8/.well-known/oauth-protected-resource/mcp") {
        return json({
          resource: "https://8.8.8.8/mcp",
          authorization_servers: ["https://8.8.4.4"],
          scopes_supported: ["database:read"],
        });
      }
      if (url.href === "https://8.8.4.4/.well-known/oauth-authorization-server") {
        return json({
          issuer: "https://8.8.4.4",
          authorization_endpoint: "https://8.8.4.4/authorize",
          token_endpoint: "https://8.8.4.4/token",
          registration_endpoint: "https://8.8.4.4/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/authorize" && url.searchParams.get("client_id") === "revoked-client") {
        cachedClientProbes += 1;
        probeState = url.searchParams.get("state");
        probeChallenge = url.searchParams.get("code_challenge");
        return json({ message: "Unrecognized client_id" }, 400);
      }
      if (url.href === "https://8.8.4.4/register") {
        registrations += 1;
        return json({
          client_id: "replacement-client",
          client_secret: "replacement-secret",
          redirect_uris: ["https://app.example.com/api/capabilities/oauth/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_basic",
        }, 201);
      }
      return new Response("not found", { status: 404 });
    };

    const randomValues = ["browser-state", "probe-verifier", "probe-state"];
    const result = await startOAuthAuthorization({
      workspaceId,
      userId,
      endpointUrl: "https://8.8.8.8/mcp",
      allowedHosts: ["8.8.8.8"],
      appOrigin: "https://app.example.com",
    }, {
      repository,
      secrets,
      createPinnedFetch: () => fetchFn,
      now: () => new Date("2026-07-17T08:30:00.000Z"),
      randomState: () => randomValues.shift() ?? "unexpected-random-value",
      randomId: () => attemptId,
      wait: async () => {},
    });

    expect(cachedClientProbes).toBe(1);
    expect(registrations).toBe(1);
    const browserAuthorization = new URL(result.authorizationUrl);
    expect(browserAuthorization.searchParams.get("client_id")).toBe("replacement-client");
    expect(browserAuthorization.searchParams.get("state")).toBe("browser-state");
    expect(probeState).toBe("probe-state");
    expect(probeState).not.toBe(browserAuthorization.searchParams.get("state"));
    expect(probeChallenge).not.toBe(browserAuthorization.searchParams.get("code_challenge"));
    expect(repository.clients.get(clientId)).toMatchObject({ status: "active" });
    const attemptSecret = await secrets.get(repository.attempts.get(attemptId)!.secretRef);
    expect(JSON.parse(attemptSecret ?? "{}")).toHaveProperty(
      "clientInformation.client_id",
      "replacement-client",
    );
  });

  it("does not reuse or probe a DCR client older than the freshness TTL", async () => {
    const repository = new MemoryRepository();
    const secrets = new MemorySecrets();
    const clientId = "66666666-6666-4666-8666-666666666666";
    const clientSecretRef = await secrets.put({
      name: "stale-client",
      plaintext: JSON.stringify({
        clientInformation: {
          client_id: "stale-client",
          client_secret: "stale-secret",
          client_secret_expires_at: 0,
          redirect_uris: ["https://app.example.com/api/capabilities/oauth/callback"],
        },
        discoveryState: { authorizationServerUrl: "https://8.8.4.4/" },
        oauthHosts: ["8.8.4.4"],
      }),
    });
    repository.clients.set(clientId, {
      id: clientId,
      workspaceId,
      issuer: "https://8.8.4.4/",
      redirectUri: "https://app.example.com/api/capabilities/oauth/callback",
      secretRef: clientSecretRef,
      status: "active",
      updatedAt: "2026-07-17T08:19:59.000Z",
    });
    let registrations = 0;
    let authorizationProbes = 0;
    const fetchFn = oauthStartFetch({
      authorization: () => {
        authorizationProbes += 1;
        return new Response(null, { status: 303 });
      },
      registration: () => {
        registrations += 1;
        return json({
          client_id: "fresh-client",
          client_secret: "fresh-secret",
          redirect_uris: ["https://app.example.com/api/capabilities/oauth/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_basic",
        }, 201);
      },
    });

    const result = await startOAuthAuthorization({
      workspaceId,
      userId,
      endpointUrl: "https://8.8.8.8/mcp",
      allowedHosts: ["8.8.8.8"],
      appOrigin: "https://app.example.com",
    }, {
      repository,
      secrets,
      createPinnedFetch: () => fetchFn,
      now: () => new Date("2026-07-17T08:30:00.000Z"),
      randomState: () => "browser-state",
      randomId: () => attemptId,
      wait: async () => {},
    });

    expect(registrations).toBe(1);
    expect(authorizationProbes).toBe(0);
    expect(new URL(result.authorizationUrl).searchParams.get("client_id")).toBe("fresh-client");
  });

  it("registers an OAuth capability atomically and treats a replay as idempotent", async () => {
    const repository = new MemoryRepository();
    const secrets = new MemorySecrets();
    const secretRef = await secrets.put({ name: "authorized-attempt", plaintext: "{}" });
    repository.attempts.set(attemptId, {
      id: attemptId,
      workspaceId,
      createdBy: userId,
      endpointUrl: "https://8.8.8.8/mcp",
      allowedHosts: ["8.8.8.8"],
      issuer: "https://8.8.4.4",
      resourceUrl: "https://8.8.8.8/",
      scopes: [],
      stateHash: "state-hash",
      secretRef,
      status: "authorized",
      expiresAt: "2026-07-17T01:00:00.000Z",
      connectedAt: "2026-07-17T00:00:00.000Z",
      consumedAt: null,
      capabilityId: null,
      errorCode: null,
    });
    const input: RegisterOAuthCapabilityInput = {
      workspaceId,
      userId,
      attemptId,
      expectedEndpointUrl: "https://8.8.8.8/mcp",
      key: "oauth_provider",
      provider: "OAuth Provider",
      title: "OAuth tools",
      description: "Managed OAuth tools",
      provenance: {},
      environment: "production",
      contract: { protocol: "mcp_streamable_http", tools: [] },
      contractDigest: "digest",
      changeSummary: null,
      status: "approved",
      timeoutMs: 15000,
    };

    await expect(registerOAuthCapability(input, { repository, secrets }))
      .resolves.toMatchObject({ capabilityId, connectionId, created: true });
    await expect(registerOAuthCapability(input, { repository, secrets }))
      .resolves.toMatchObject({ capabilityId, connectionId, created: false });
    expect(repository.attempts.get(attemptId)).toMatchObject({
      status: "connected",
      capabilityId,
    });
    expect(repository.credentials.size).toBe(1);
  });

  it("rejects protected-resource metadata that changes the endpoint query scope", async () => {
    const repository = new MemoryRepository();
    const secrets = new MemorySecrets();
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      if (url === "https://8.8.8.8/mcp?project_ref=expected") {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": "Bearer resource_metadata=\"https://8.8.8.8/.well-known/oauth-protected-resource/mcp?project_ref=expected\"" },
        });
      }
      return json({
        resource: "https://8.8.8.8/mcp?project_ref=other",
        authorization_servers: ["https://8.8.4.4"],
      });
    };
    await expect(startOAuthAuthorization({
      workspaceId,
      userId,
      endpointUrl: "https://8.8.8.8/mcp?project_ref=expected",
      allowedHosts: ["8.8.8.8"],
      appOrigin: "https://app.example.com",
    }, {
      repository,
      secrets,
      createPinnedFetch: () => fetchFn,
      now: () => new Date("2026-07-17T00:00:00.000Z"),
      randomState: () => "state",
      randomId: () => attemptId,
      wait: async () => {},
    })).rejects.toMatchObject({ code: "oauth_resource_mismatch" });
  });

  it("rejects protected-resource metadata that drops endpoint query scope", async () => {
    const repository = new MemoryRepository();
    const secrets = new MemorySecrets();
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      if (url === "https://8.8.8.8/mcp?project_ref=expected&read_only=true") {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": "Bearer resource_metadata=\"https://8.8.8.8/.well-known/oauth-protected-resource/mcp?project_ref=expected&read_only=true\"" },
        });
      }
      return json({
        resource: "https://8.8.8.8/mcp",
        authorization_servers: ["https://8.8.4.4"],
      });
    };
    await expect(startOAuthAuthorization({
      workspaceId,
      userId,
      endpointUrl: "https://8.8.8.8/mcp?project_ref=expected&read_only=true",
      allowedHosts: ["8.8.8.8"],
      appOrigin: "https://app.example.com",
    }, {
      repository,
      secrets,
      createPinnedFetch: () => fetchFn,
      now: () => new Date("2026-07-17T00:00:00.000Z"),
      randomState: () => "state",
      randomId: () => attemptId,
      wait: async () => {},
    })).rejects.toMatchObject({ code: "oauth_resource_mismatch" });
  });

  it("caps OAuth discovery response bodies", async () => {
    const repository = new MemoryRepository();
    const secrets = new MemorySecrets();
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      if (url === "https://8.8.8.8/mcp") {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": "Bearer resource_metadata=\"https://8.8.8.8/.well-known/oauth-protected-resource/mcp\"" },
        });
      }
      return new Response("x", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "1000001" },
      });
    };
    await expect(startOAuthAuthorization({
      workspaceId,
      userId,
      endpointUrl: "https://8.8.8.8/mcp",
      allowedHosts: ["8.8.8.8"],
      appOrigin: "https://app.example.com",
    }, {
      repository,
      secrets,
      createPinnedFetch: () => fetchFn,
      now: () => new Date("2026-07-17T00:00:00.000Z"),
      randomState: () => "state",
      randomId: () => attemptId,
      wait: async () => {},
    })).rejects.toMatchObject({ code: "oauth_response_too_large" });
  });

  it("fails and cleans an attempt when callback state has no PKCE verifier", async () => {
    const repository = new MemoryRepository();
    const secrets = new MemorySecrets();
    const state = "callback-state";
    const secretRef = await secrets.put({
      name: "attempt-without-verifier",
      plaintext: JSON.stringify({
        clientInformation: { client_id: "dcr-client" },
        discoveryState: { authorizationServerUrl: "https://8.8.4.4/" },
        oauthHosts: ["8.8.4.4"],
      }),
    });
    repository.attempts.set(attemptId, {
      id: attemptId,
      workspaceId,
      createdBy: userId,
      endpointUrl: "https://8.8.8.8/mcp",
      allowedHosts: ["8.8.8.8"],
      issuer: "https://8.8.4.4/",
      resourceUrl: "https://8.8.8.8/",
      scopes: [],
      stateHash: createHash("sha256").update(state).digest("hex"),
      secretRef,
      status: "pending",
      expiresAt: "2026-07-17T01:00:00.000Z",
      connectedAt: null,
      consumedAt: null,
      capabilityId: null,
      errorCode: null,
    });

    await expect(
      completeOAuthAuthorization(
        {
          userId,
          state,
          code: "authorization-code",
          appOrigin: "https://app.example.com",
        },
        {
          repository,
          secrets,
          now: () => new Date("2026-07-17T00:05:00.000Z"),
        },
      ),
    ).rejects.toMatchObject({
      code: "oauth_verifier_missing",
      httpStatus: 409,
    });
    expect(repository.attempts.get(attemptId)).toMatchObject({
      status: "failed",
      errorCode: "oauth_verifier_missing",
    });
    expect(await secrets.get(secretRef)).toBeNull();
  });

  it("cancels callback exchange when the requester is no longer a workspace admin", async () => {
    const repository = new MemoryRepository();
    const secrets = new MemorySecrets();
    const state = "revoked-admin-state";
    const secretRef = await secrets.put({
      name: "revoked-admin-attempt",
      plaintext: JSON.stringify({
        clientInformation: { client_id: "dcr-client" },
        discoveryState: { authorizationServerUrl: "https://8.8.4.4/" },
        oauthHosts: ["8.8.4.4"],
        codeVerifier: "verifier",
      }),
    });
    repository.attempts.set(attemptId, {
      id: attemptId,
      workspaceId,
      createdBy: userId,
      endpointUrl: "https://8.8.8.8/mcp",
      allowedHosts: ["8.8.8.8"],
      issuer: "https://8.8.4.4/",
      resourceUrl: "https://8.8.8.8/",
      scopes: [],
      stateHash: createHash("sha256").update(state).digest("hex"),
      secretRef,
      status: "pending",
      expiresAt: "2026-07-17T01:00:00.000Z",
      connectedAt: null,
      consumedAt: null,
      capabilityId: null,
      errorCode: null,
    });
    repository.admins.delete(userId);

    await expect(
      completeOAuthAuthorization(
        {
          userId,
          state,
          code: "authorization-code",
          appOrigin: "https://app.example.com",
        },
        {
          repository,
          secrets,
          now: () => new Date("2026-07-17T00:05:00.000Z"),
          createPinnedFetch: () => async () => {
            throw new Error("token endpoint must not be called");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "oauth_admin_required",
      httpStatus: 403,
    });
    expect(repository.attempts.get(attemptId)).toMatchObject({
      status: "cancelled",
      errorCode: "oauth_admin_required",
    });
    expect(await secrets.get(secretRef)).toBeNull();
  });

  it("cancels an authorized attempt and removes its unclaimed Vault bundle", async () => {
    const repository = new MemoryRepository();
    const secrets = new MemorySecrets();
    const secretRef = await secrets.put({ name: "authorized-attempt", plaintext: "sensitive" });
    repository.attempts.set(attemptId, {
      id: attemptId,
      workspaceId,
      createdBy: userId,
      endpointUrl: "https://8.8.8.8/mcp",
      allowedHosts: ["8.8.8.8"],
      issuer: "https://8.8.4.4",
      resourceUrl: "https://8.8.8.8/",
      scopes: [],
      stateHash: "state-hash",
      secretRef,
      status: "authorized",
      expiresAt: "2026-07-17T01:00:00.000Z",
      connectedAt: "2026-07-17T00:00:00.000Z",
      consumedAt: null,
      capabilityId: null,
      errorCode: null,
    });

    const cancelled = await cancelOAuthAttempt({ workspaceId, userId, attemptId }, {
      repository,
      secrets,
      now: () => new Date("2026-07-17T00:05:00.000Z"),
    });

    expect(cancelled.status).toBe("cancelled");
    expect(await secrets.get(secretRef)).toBeNull();
  });

  it("expires an abandoned attempt and removes its Vault bundle", async () => {
    const repository = new MemoryRepository();
    const secrets = new MemorySecrets();
    const secretRef = await secrets.put({
      name: "expired-attempt",
      plaintext: "sensitive",
    });
    repository.attempts.set(attemptId, {
      id: attemptId,
      workspaceId,
      createdBy: userId,
      endpointUrl: "https://8.8.8.8/mcp",
      allowedHosts: ["8.8.8.8"],
      issuer: "https://8.8.4.4",
      resourceUrl: "https://8.8.8.8/",
      scopes: [],
      stateHash: "state-hash",
      secretRef,
      status: "pending",
      expiresAt: "2026-07-17T00:10:00.000Z",
      connectedAt: null,
      consumedAt: null,
      capabilityId: null,
      errorCode: null,
    });

    const result = await getOAuthAttemptStatus(
      { workspaceId, userId, attemptId },
      {
        repository,
        secrets,
        now: () => new Date("2026-07-17T00:10:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      status: "expired",
      errorCode: "oauth_attempt_expired",
    });
    expect(await secrets.get(secretRef)).toBeNull();
  });

  it("requires reauthorization when an expired credential has no refresh token", async () => {
    const repository = new MemoryRepository();
    const secrets = new MemorySecrets();
    const secretRef = await secrets.put({
      name: "credential-without-refresh",
      plaintext: JSON.stringify({
        clientInformation: { client_id: "dcr-client" },
        discoveryState: { authorizationServerUrl: "https://8.8.4.4/" },
        oauthHosts: ["8.8.4.4"],
        tokens: { access_token: "expired-access", token_type: "Bearer" },
        tokenExpiresAt: "2026-07-17T00:00:00.000Z",
      }),
    });
    repository.credentials.set(connectionId, {
      id: "77777777-7777-4777-8777-777777777777",
      workspaceId,
      connectionId,
      attemptId,
      secretRef,
      issuer: "https://8.8.4.4/",
      resourceUrl: "https://8.8.8.8/",
      scopes: [],
      status: "active",
      tokenExpiresAt: "2026-07-17T00:00:00.000Z",
      refreshLeaseToken: null,
      refreshLeaseUntil: null,
      revision: 1,
    });

    await expect(
      getOAuthAccessTokenForConnection(
        { workspaceId, connectionId },
        {
          repository,
          secrets,
          now: () => new Date("2026-07-17T01:00:00.000Z"),
          randomId: () => "88888888-8888-4888-8888-888888888888",
        },
      ),
    ).rejects.toMatchObject({
      code: "oauth_reauthorization_required",
      httpStatus: 401,
    });
    expect(repository.credentials.get(connectionId)).toMatchObject({
      status: "needs_reauth",
      refreshLeaseToken: null,
      refreshLeaseUntil: null,
      revision: 2,
    });
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function oauthStartFetch(options: {
  authorization?: (url: URL) => Response;
  registration?: () => Response;
} = {}): FetchLike {
  return async (input) => {
    const url = new URL(String(input));
    if (url.href === "https://8.8.8.8/mcp") {
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": "Bearer resource_metadata=\"https://8.8.8.8/.well-known/oauth-protected-resource/mcp\"",
        },
      });
    }
    if (url.href === "https://8.8.8.8/.well-known/oauth-protected-resource/mcp") {
      return json({
        resource: "https://8.8.8.8/mcp",
        authorization_servers: ["https://8.8.4.4"],
        scopes_supported: ["database:read"],
      });
    }
    if (url.href === "https://8.8.4.4/.well-known/oauth-authorization-server") {
      return json({
        issuer: "https://8.8.4.4",
        authorization_endpoint: "https://8.8.4.4/authorize",
        token_endpoint: "https://8.8.4.4/token",
        registration_endpoint: "https://8.8.4.4/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/authorize") {
      return options.authorization?.(url) ?? new Response(null, { status: 303 });
    }
    if (url.href === "https://8.8.4.4/register") {
      return options.registration?.() ?? new Response("registration not configured", { status: 500 });
    }
    return new Response("not found", { status: 404 });
  };
}

class MemorySecrets implements OAuthSecretStore {
  private readonly refs = new Map<string, string>();
  private readonly values = new Map<string, string>();
  private next = 1;
  async get(ref: string | null): Promise<string | null> { return ref ? this.values.get(ref) ?? null : null; }
  async put(input: { name: string; plaintext: string }): Promise<string> {
    let ref = this.refs.get(input.name);
    if (!ref) {
      ref = `vault:00000000-0000-4000-8000-${String(this.next++).padStart(12, "0")}`;
      this.refs.set(input.name, ref);
    }
    this.values.set(ref, input.plaintext);
    return ref;
  }
  async delete(ref: string | null): Promise<boolean> {
    return ref ? this.values.delete(ref) : false;
  }
}

class MemoryRepository implements OAuthRepository {
  admins = new Set([userId]);
  clients = new Map<string, OAuthClientRecord>();
  attempts = new Map<string, OAuthAttemptRecord>();
  credentials = new Map<string, OAuthCredentialRecord>();
  async isWorkspaceAdmin(input: { workspaceId: string; userId: string }) {
    return input.workspaceId === workspaceId && this.admins.has(input.userId);
  }
  async expireAttempts(input: { workspaceId: string; now: string; limit: number }) {
    const expired: Array<{ id: string; secretRef: string }> = [];
    for (const row of this.attempts.values()) {
      if (expired.length >= input.limit) break;
      if (
        row.workspaceId === input.workspaceId &&
        (row.status === "pending" || row.status === "authorized") &&
        Date.parse(row.expiresAt) <= Date.parse(input.now)
      ) {
        row.status = "expired";
        row.errorCode = "oauth_attempt_expired";
        expired.push({ id: row.id, secretRef: row.secretRef });
      }
    }
    return expired;
  }
  async findActiveClient(input: { workspaceId: string; issuer: string; redirectUri: string }) {
    return [...this.clients.values()].find((row) => row.workspaceId === input.workspaceId && row.issuer === input.issuer && row.redirectUri === input.redirectUri && row.status === "active") ?? null;
  }
  async createPendingClient(input: { workspaceId: string; issuer: string; redirectUri: string }) {
    const row: OAuthClientRecord = {
      id: "66666666-6666-4666-8666-666666666666",
      ...input,
      secretRef: null,
      status: "pending",
      updatedAt: new Date().toISOString(),
    };
    this.clients.set(row.id, row); return row;
  }
  async activateClient(input: { id: string; workspaceId: string; secretRef: string }) {
    const row = this.clients.get(input.id)!;
    Object.assign(row, { secretRef: input.secretRef, status: "active", updatedAt: new Date().toISOString() });
    return row;
  }
  async failClient(input: { id: string; workspaceId: string; errorCode: string }) { const row = this.clients.get(input.id); if (row) row.status = "failed"; }
  async invalidateClient(input: { workspaceId: string; issuer: string }) {
    for (const row of this.clients.values()) {
      if (row.workspaceId === input.workspaceId && row.issuer === input.issuer && row.status === "active") row.status = "failed";
    }
  }
  async createAttempt(input: Omit<OAuthAttemptRecord, "connectedAt" | "consumedAt" | "capabilityId" | "errorCode">) {
    const row: OAuthAttemptRecord = { ...input, connectedAt: null, consumedAt: null, capabilityId: null, errorCode: null };
    this.attempts.set(row.id, row); return row;
  }
  async getAttemptByStateHash(hash: string) { return [...this.attempts.values()].find((row) => row.stateHash === hash) ?? null; }
  async getAttempt(input: { workspaceId: string; attemptId: string; createdBy?: string }) {
    const row = this.attempts.get(input.attemptId);
    return row && row.workspaceId === input.workspaceId && (!input.createdBy || row.createdBy === input.createdBy) ? row : null;
  }
  async updateAttempt(input: { id: string; workspaceId: string; expectedStatus?: OAuthAttemptRecord["status"]; patch: Partial<OAuthAttemptRecord> }) {
    const row = this.attempts.get(input.id);
    if (!row || row.workspaceId !== input.workspaceId || (input.expectedStatus && row.status !== input.expectedStatus)) return null;
    Object.assign(row, input.patch); return row;
  }
  async registerCapability(input: RegisterOAuthCapabilityInput) {
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt || attempt.workspaceId !== input.workspaceId || attempt.createdBy !== input.userId) {
      throw new Error("oauth_attempt_not_attachable");
    }
    if (attempt.status === "connected" && attempt.capabilityId === capabilityId) {
      return {
        capabilityId,
        versionId: "88888888-8888-4888-8888-888888888888",
        connectionId,
        created: false,
      };
    }
    if (attempt.status !== "authorized" || attempt.endpointUrl !== input.expectedEndpointUrl) {
      throw new Error("oauth_attempt_not_attachable");
    }
    await this.attachCredential({
      workspaceId: input.workspaceId,
      userId: input.userId,
      connectionId,
      attemptId: input.attemptId,
      capabilityId,
      endpointUrl: input.expectedEndpointUrl,
      tokenExpiresAt: null,
    });
    return {
      capabilityId,
      versionId: "88888888-8888-4888-8888-888888888888",
      connectionId,
      created: true,
    };
  }
  async attachCredential(input: { workspaceId: string; userId: string; connectionId: string; attemptId: string; capabilityId: string; endpointUrl: string; tokenExpiresAt: string | null }) {
    const attempt = this.attempts.get(input.attemptId)!;
    const row: OAuthCredentialRecord = { id: "77777777-7777-4777-8777-777777777777", workspaceId: input.workspaceId,
      connectionId: input.connectionId, attemptId: attempt.id, secretRef: attempt.secretRef,
      issuer: attempt.issuer, resourceUrl: attempt.resourceUrl, scopes: attempt.scopes,
      status: "active", tokenExpiresAt: input.tokenExpiresAt, refreshLeaseToken: null, refreshLeaseUntil: null, revision: 1 };
    this.credentials.set(input.connectionId, row);
    Object.assign(attempt, { status: "connected", capabilityId: input.capabilityId, consumedAt: "2026-07-17T00:00:00.000Z" });
    return row;
  }
  async getCredentialByConnection(input: { workspaceId: string; connectionId: string }) {
    const row = this.credentials.get(input.connectionId); return row?.workspaceId === input.workspaceId ? row : null;
  }
  async claimRefreshLease(input: { workspaceId: string; credentialId: string; expectedRevision: number; leaseId: string; leaseUntil: string; now: string }) {
    const row = [...this.credentials.values()].find((value) => value.id === input.credentialId && value.workspaceId === input.workspaceId);
    if (!row || row.revision !== input.expectedRevision || (row.status !== "active" && !(row.status === "refreshing" && Date.parse(row.refreshLeaseUntil ?? "") < Date.parse(input.now)))) return null;
    Object.assign(row, { status: "refreshing", refreshLeaseToken: input.leaseId, refreshLeaseUntil: input.leaseUntil }); return row;
  }
  async finishRefresh(input: { workspaceId: string; credentialId: string; expectedRevision: number; leaseId: string; status: OAuthCredentialRecord["status"]; tokenExpiresAt: string | null; secretRef?: string; lastError?: string | null }) {
    const row = [...this.credentials.values()].find((value) => value.id === input.credentialId && value.revision === input.expectedRevision && value.refreshLeaseToken === input.leaseId);
    if (!row) return null;
    Object.assign(row, { status: input.status, tokenExpiresAt: input.tokenExpiresAt, secretRef: input.secretRef ?? row.secretRef,
      refreshLeaseToken: null, refreshLeaseUntil: null, revision: row.revision + 1 }); return row;
  }
}
