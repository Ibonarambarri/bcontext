import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FORM,
  MAX_SECRET_LENGTH,
  type ProviderForm,
  buildConnection,
  buildUpdateConnection,
  connectionFingerprint,
  describeDiscoveredProvider,
  inferProviderMetadata,
  isProviderConnectionValid,
  isValidHttpsProviderEndpoint,
  mergeDiscoveryIntoForm,
  providerFormFromDetail,
  sameConnection,
  sanitizeUntrustedMetadata,
} from "./provider-shared";

const DISCOVERED = {
  title: "Supabase",
  provider: "Supabase",
  description: "Supabase MCP server exposing 2 tools.",
  tools: [
    { name: "list_tables", description: "", inputSchema: {} },
    { name: "execute_sql", description: "", inputSchema: {} },
  ],
  logoUrl: "https://supabase.com/favicon.ico",
  logoSource: "provider_homepage",
  declaredMetadata: { title: "Supabase MCP" },
};

describe("tool provider URL-first form", () => {
  it("infers Supabase metadata from the only required MCP input", () => {
    expect(inferProviderMetadata(
      "https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnopqrst&read_only=true",
    )).toEqual({
      title: "Supabase",
      provider: "Supabase",
      description: "Supabase tools connected through MCP.",
    });
  });

  it("handles country-code domains and humanizes provider labels", () => {
    expect(inferProviderMetadata("https://mcp.data-cloud.co.uk/v1/mcp")).toMatchObject({
      title: "Data Cloud",
      provider: "Data Cloud",
    });
  });

  it("accepts only credential-free HTTPS endpoints", () => {
    expect(isValidHttpsProviderEndpoint("https://mcp.example.com/mcp")).toBe(true);
    expect(isValidHttpsProviderEndpoint("http://mcp.example.com/mcp")).toBe(false);
    expect(isValidHttpsProviderEndpoint("https://user:secret@mcp.example.com/mcp")).toBe(false);
    expect(inferProviderMetadata("not a URL")).toBeNull();
  });

  it("summarizes the automatically imported tool catalog", () => {
    expect(describeDiscoveredProvider("Supabase", 1)).toBe("Supabase MCP server exposing 1 tool.");
    expect(describeDiscoveredProvider("Supabase", 12)).toBe("Supabase MCP server exposing 12 tools.");
  });

  it("removes invisible and bidi controls from remote display text", () => {
    expect(sanitizeUntrustedMetadata("Git\u202eHub\u200b MCP\u2066", 100)).toBe("GitHub MCP");
  });

  it("requires an explicit auth choice before discovery or gateway registration", () => {
    const connection = {
      endpointUrl: "https://mcp.supabase.com/mcp",
      authType: "none" as const,
      oauthAttemptId: "",
      authHeaderName: "",
      secret: "",
    };

    expect(isProviderConnectionValid(connection, false)).toBe(false);
    expect(isProviderConnectionValid(connection, true)).toBe(true);
  });

  it("requires the selected authentication method to be ready after confirmation", () => {
    const connection = {
      endpointUrl: "https://mcp.example.com/mcp",
      authType: "oauth" as const,
      oauthAttemptId: "",
      authHeaderName: "",
      secret: "",
    };

    expect(isProviderConnectionValid(connection, true)).toBe(false);
    expect(isProviderConnectionValid({ ...connection, oauthAttemptId: "attempt-1" }, true)).toBe(true);
    expect(isProviderConnectionValid({ ...connection, authType: "bearer", secret: "sk-live-example" }, true)).toBe(true);
    expect(isProviderConnectionValid({ ...connection, authType: "header", secret: "sk-live-example" }, true)).toBe(false);
    expect(isProviderConnectionValid({
      ...connection,
      authType: "header",
      authHeaderName: "X-API-Key",
      secret: "sk-live-example",
    }, true)).toBe(true);
  });

  it("accepts any pasted token that is non-empty after trimming and within the size cap", () => {
    const bearer = { ...EMPTY_FORM, endpointUrl: "https://mcp.example.com/mcp", authType: "bearer" as const };
    expect(isProviderConnectionValid({ ...bearer, secret: "" }, true)).toBe(false);
    expect(isProviderConnectionValid({ ...bearer, secret: "   \n" }, true)).toBe(false);
    expect(isProviderConnectionValid({ ...bearer, secret: "  sk-live-example\n" }, true)).toBe(true);
    expect(isProviderConnectionValid({ ...bearer, secret: "a".repeat(MAX_SECRET_LENGTH) }, true)).toBe(true);
    expect(isProviderConnectionValid({ ...bearer, secret: "a".repeat(MAX_SECRET_LENGTH + 1) }, true)).toBe(false);
  });

  it("requires a replacement token only when the user chose to replace a stored credential", () => {
    const stored = {
      ...EMPTY_FORM,
      capabilityId: "11111111-1111-4111-8111-111111111111",
      endpointUrl: "https://mcp.example.com/mcp",
      authType: "bearer" as const,
      credentialMode: "preserve" as const,
      credentialConfigured: true,
    };
    expect(isProviderConnectionValid(stored, true)).toBe(true);
    expect(isProviderConnectionValid({ ...stored, credentialMode: "replace", credentialConfigured: false }, true)).toBe(false);
    expect(isProviderConnectionValid({ ...stored, credentialMode: "replace", credentialConfigured: false, secret: "new-token" }, true)).toBe(true);
  });

  it("loads an existing OAuth provider without exposing or replacing its credential", () => {
    const form = providerFormFromDetail({
      capability: {
        id: "11111111-1111-4111-8111-111111111111",
        key: "supabase",
        type: "mcp_server",
        provider: "Supabase",
        title: "Supabase",
        description: "Supabase MCP server exposing 20 tools.",
        provenance: {
          logo_url: "https://supabase.com/favicon/favicon.ico",
          logo_source: "provider_homepage",
        },
        status: "approved",
        created_at: "2026-07-17T09:00:00.000Z",
        updated_at: "2026-07-17T10:00:00.000Z",
      },
      version: {
        contract: {
          protocol: "mcp_streamable_http",
          tools: [{ name: "list_tables", description: "List tables", inputSchema: { type: "object" } }],
        },
      },
      connection: {
        endpoint_url: "https://mcp.supabase.com/mcp?project_ref=project",
        auth_type: "oauth",
        auth_header_name: null,
        timeout_ms: 15000,
        credential_configured: true,
      },
    });

    expect(form).toMatchObject({
      capabilityId: "11111111-1111-4111-8111-111111111111",
      authType: "oauth",
      credentialMode: "preserve",
      credentialConfigured: true,
      secret: "",
      oauthAttemptId: "",
      logoUrl: "https://supabase.com/favicon/favicon.ico",
    });
    expect(isProviderConnectionValid(form, true)).toBe(true);
  });

  it("fills identity from discovery when adding a new provider", () => {
    const merged = mergeDiscoveryIntoForm(
      { ...EMPTY_FORM, endpointUrl: "https://mcp.supabase.com/mcp" },
      DISCOVERED,
    );
    expect(merged.title).toBe("Supabase");
    expect(merged.provider).toBe("Supabase");
    expect(merged.tools).toHaveLength(2);
    expect(merged.logoUrl).toBe("https://supabase.com/favicon.ico");
  });

  it("preserves a custom connection name when re-discovering an edited provider", () => {
    const merged = mergeDiscoveryIntoForm(
      {
        ...EMPTY_FORM,
        capabilityId: "11111111-1111-4111-8111-111111111111",
        title: "Supabase Prod",
        provider: "Supabase",
        description: "Production project connection.",
        endpointUrl: "https://mcp.supabase.com/mcp?project_ref=prod",
      },
      DISCOVERED,
    );
    expect(merged.title).toBe("Supabase Prod");
    expect(merged.description).toBe("Production project connection.");
    expect(merged.tools).toHaveLength(2);
    expect(merged.declaredMetadata).toEqual({ title: "Supabase MCP" });
  });
});

const TOKEN = "sk-live-4f8c2e7a9b1d3f6e";

function bearerForm(overrides: Partial<ProviderForm> = {}): ProviderForm {
  return {
    ...EMPTY_FORM,
    endpointUrl: "https://mcp.example.com/mcp",
    authType: "bearer",
    secret: `  ${TOKEN}\n`,
    ...overrides,
  };
}

describe("tool provider credentials", () => {
  it("keys discovery on the token without ever exposing it", () => {
    const fingerprint = connectionFingerprint(bearerForm());
    expect(fingerprint).not.toContain(TOKEN);
    expect(fingerprint).not.toContain(TOKEN.slice(0, 8));
    expect(sameConnection(bearerForm(), bearerForm({ secret: TOKEN }))).toBe(true);
    expect(sameConnection(bearerForm(), bearerForm({ secret: "another-token" }))).toBe(false);
    expect(sameConnection(bearerForm(), bearerForm({ title: "Renamed", description: "Labels are not identity" }))).toBe(true);
  });

  it("sends the trimmed token as `secret` on create and discovery", () => {
    expect(buildConnection(bearerForm())).toEqual({
      endpointUrl: "https://mcp.example.com/mcp",
      authType: "bearer",
      allowedHosts: ["mcp.example.com"],
      timeoutMs: 15000,
      secret: TOKEN,
    });
    expect(buildConnection(bearerForm({ authType: "header", authHeaderName: " X-API-Key " }))).toMatchObject({
      authType: "header",
      authHeaderName: "X-API-Key",
      secret: TOKEN,
    });
    expect(buildConnection(bearerForm({ authType: "none", secret: TOKEN }))).not.toHaveProperty("secret");
    expect(buildConnection(bearerForm({ authType: "oauth", oauthAttemptId: "attempt-1", secret: TOKEN }))).toEqual({
      endpointUrl: "https://mcp.example.com/mcp",
      authType: "oauth",
      allowedHosts: ["mcp.example.com"],
      timeoutMs: 15000,
      oauthAttemptId: "attempt-1",
    });
  });

  it("keeps the stored credential on update unless the user replaces it", () => {
    const editing = bearerForm({
      capabilityId: "11111111-1111-4111-8111-111111111111",
      secret: "",
      credentialMode: "preserve",
      credentialConfigured: true,
    });
    expect(buildUpdateConnection(editing)).toEqual({
      endpointUrl: "https://mcp.example.com/mcp",
      authType: "bearer",
      credentialMode: "preserve",
      allowedHosts: ["mcp.example.com"],
      timeoutMs: 15000,
    });
    expect(buildUpdateConnection({ ...editing, credentialMode: "replace", credentialConfigured: false, secret: `${TOKEN} ` })).toEqual({
      endpointUrl: "https://mcp.example.com/mcp",
      authType: "bearer",
      credentialMode: "replace",
      allowedHosts: ["mcp.example.com"],
      timeoutMs: 15000,
      secret: TOKEN,
    });
    expect(buildUpdateConnection({ ...editing, authType: "header", authHeaderName: "X-API-Key" })).toEqual({
      endpointUrl: "https://mcp.example.com/mcp",
      authType: "header",
      credentialMode: "preserve",
      authHeaderName: "X-API-Key",
      allowedHosts: ["mcp.example.com"],
      timeoutMs: 15000,
    });
    expect(buildUpdateConnection({ ...editing, authType: "none", credentialMode: "preserve" })).toMatchObject({ credentialMode: "replace" });
  });

  it("never carries a secret reference on the wire", () => {
    for (const body of [buildConnection(bearerForm()), buildUpdateConnection(bearerForm({ credentialMode: "replace" }))]) {
      expect(JSON.stringify(body)).not.toMatch(/secretRef|secret_ref|BCONTEXT_CAP_/);
    }
  });

  it("loads a stored bearer credential as opaque and locked until replaced", () => {
    const form = providerFormFromDetail({
      capability: {
        id: "11111111-1111-4111-8111-111111111111",
        key: "acme",
        type: "mcp_server",
        provider: "Acme",
        title: "Acme",
        description: "Acme MCP server exposing 1 tool.",
        provenance: {},
        status: "approved",
        created_at: "2026-07-17T09:00:00.000Z",
        updated_at: "2026-07-17T10:00:00.000Z",
      },
      version: { contract: { protocol: "mcp_streamable_http", tools: [] } },
      connection: {
        endpoint_url: "https://mcp.acme.com/mcp",
        auth_type: "header",
        auth_header_name: "X-API-Key",
        timeout_ms: 15000,
        credential_configured: true,
      },
    });
    expect(form).toMatchObject({ authType: "header", authHeaderName: "X-API-Key", secret: "", credentialMode: "preserve", credentialConfigured: true });
  });

  it("collects the token in a password field and never mentions server environment variables", () => {
    const modal = readFileSync(new URL("./provider-modal.tsx", import.meta.url), "utf8");
    expect(modal).toContain('type="password"');
    expect(modal).not.toMatch(/BCONTEXT_CAP_|secretRef|environment variable|Coolify/);
  });
});

