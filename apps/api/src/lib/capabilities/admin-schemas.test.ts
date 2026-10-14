import { describe, expect, it } from "vitest";
import {
  CreateGrantInputSchema,
  RegisterCapabilityInputSchema,
  UpdateCapabilityProviderInputSchema,
} from "./admin-schemas";

const workspaceId = "11111111-1111-4111-8111-111111111111";

describe("RegisterCapabilityInputSchema", () => {
  it("accepts an allowlisted MCP Streamable HTTP capability", () => {
    const result = RegisterCapabilityInputSchema.safeParse({
      workspace_id: workspaceId,
      key: "github-mcp",
      type: "mcp_server",
      provider: "GitHub",
      title: "GitHub tools",
      status: "approved",
      contract: {
        protocol: "mcp_streamable_http",
        tools: [{ name: "create_issue", inputSchema: { type: "object", properties: {} } }],
      },
      connection: {
        endpointUrl: "https://mcp.example.com/mcp",
        authType: "bearer",
        secret: "ghp_pasted_once",
        allowedHosts: ["mcp.example.com"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a completed managed OAuth attempt", () => {
    const result = RegisterCapabilityInputSchema.safeParse({
      workspace_id: workspaceId,
      key: "oauth-mcp",
      type: "mcp_server",
      provider: "OAuth MCP",
      title: "OAuth tools",
      status: "approved",
      contract: {
        protocol: "mcp_streamable_http",
        tools: [{ name: "search", inputSchema: { type: "object" } }],
      },
      connection: {
        endpointUrl: "https://mcp.example.com/mcp",
        authType: "oauth",
        oauthAttemptId: "55555555-5555-4555-8555-555555555555",
        allowedHosts: ["mcp.example.com"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a custom header name for OAuth", () => {
    const result = RegisterCapabilityInputSchema.safeParse({
      workspace_id: workspaceId,
      key: "oauth-mcp",
      type: "mcp_server",
      provider: "OAuth MCP",
      title: "OAuth tools",
      contract: {
        protocol: "mcp_streamable_http",
        tools: [{ name: "search", inputSchema: { type: "object" } }],
      },
      connection: {
        endpointUrl: "https://mcp.example.com/mcp",
        authType: "oauth",
        authHeaderName: "X-Token",
        oauthAttemptId: "55555555-5555-4555-8555-555555555555",
        allowedHosts: ["mcp.example.com"],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a static secret instead of a completed OAuth attempt", () => {
    const result = RegisterCapabilityInputSchema.safeParse({
      workspace_id: workspaceId,
      key: "legacy-oauth-mcp",
      type: "mcp_server",
      provider: "OAuth MCP",
      title: "OAuth tools",
      contract: {
        protocol: "mcp_streamable_http",
        tools: [{ name: "search", inputSchema: { type: "object" } }],
      },
      connection: {
        endpointUrl: "https://mcp.example.com/mcp",
        authType: "oauth",
        secret: "not-how-oauth-works",
        allowedHosts: ["mcp.example.com"],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects OAuth for workflows", () => {
    const result = RegisterCapabilityInputSchema.safeParse({
      workspace_id: workspaceId,
      key: "oauth-workflow",
      type: "workflow",
      provider: "Example",
      title: "Workflow",
      contract: {
        protocol: "webhook",
        tool: { name: "run", inputSchema: { type: "object" } },
      },
      connection: {
        endpointUrl: "https://example.com/run",
        authType: "oauth",
        oauthAttemptId: "55555555-5555-4555-8555-555555555555",
        allowedHosts: ["example.com"],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an endpoint whose host is missing from the allowlist", () => {
    const result = RegisterCapabilityInputSchema.safeParse({
      workspace_id: workspaceId,
      key: "n8n-hook",
      type: "workflow",
      provider: "n8n",
      title: "Deploy",
      contract: {
        protocol: "webhook",
        tool: { name: "deploy", inputSchema: { type: "object" } },
      },
      connection: {
        endpointUrl: "https://hooks.example.com/deploy",
        authType: "header",
        authHeaderName: "x-api-key",
        secret: "actual-secret-value",
        allowedHosts: ["elsewhere.example.com"],
      },
    });
    expect(result.success).toBe(false);
  });

  it("does not let a webhook contract masquerade as an MCP server", () => {
    const result = RegisterCapabilityInputSchema.safeParse({
      workspace_id: workspaceId,
      key: "wrong-protocol",
      type: "mcp_server",
      provider: "Example",
      title: "Wrong",
      contract: {
        protocol: "webhook",
        tool: { name: "run", inputSchema: { type: "object" } },
      },
      connection: {
        endpointUrl: "https://example.com/run",
        allowedHosts: ["example.com"],
      },
    });
    expect(result.success).toBe(false);
  });

  it("requires the pasted secret for bearer and header auth, and refuses it for none", () => {
    const register = (connection: Record<string, unknown>) => RegisterCapabilityInputSchema.safeParse({
      workspace_id: workspaceId,
      key: "hooked",
      type: "workflow",
      provider: "Example",
      title: "Hook",
      contract: { protocol: "webhook", tool: { name: "run", inputSchema: { type: "object" } } },
      connection: { endpointUrl: "https://hooks.example.com/run", allowedHosts: ["hooks.example.com"], ...connection },
    });
    expect(register({ authType: "bearer" }).success).toBe(false);
    expect(register({ authType: "bearer", secret: "tok" }).success).toBe(true);
    expect(register({ authType: "header", authHeaderName: "x-api-key" }).success).toBe(false);
    expect(register({ authType: "header", authHeaderName: "x-api-key", secret: "tok" }).success).toBe(true);
    expect(register({ authType: "none", secret: "tok" }).success).toBe(false);
    expect(register({ authType: "bearer", secret: "" }).success).toBe(false);
    expect(register({ authType: "bearer", secret: "x".repeat(4097) }).success).toBe(false);
  });

  it("no longer knows the environment-variable reference", () => {
    const result = RegisterCapabilityInputSchema.safeParse({
      workspace_id: workspaceId,
      key: "legacy",
      type: "workflow",
      provider: "Example",
      title: "Legacy",
      contract: { protocol: "webhook", tool: { name: "run", inputSchema: { type: "object" } } },
      connection: {
        endpointUrl: "https://hooks.example.com/run",
        authType: "bearer",
        secretRef: "BCONTEXT_CAP_LEGACY",
        allowedHosts: ["hooks.example.com"],
      },
    });
    // Without the pasted token the env name buys nothing…
    expect(result.success).toBe(false);
    // …and with it the env name is dropped on the floor, not persisted.
    const withSecret = RegisterCapabilityInputSchema.parse({
      workspace_id: workspaceId,
      key: "legacy",
      type: "workflow",
      provider: "Example",
      title: "Legacy",
      contract: { protocol: "webhook", tool: { name: "run", inputSchema: { type: "object" } } },
      connection: {
        endpointUrl: "https://hooks.example.com/run",
        authType: "bearer",
        secretRef: "BCONTEXT_CAP_LEGACY",
        secret: "tok",
        allowedHosts: ["hooks.example.com"],
      },
    });
    expect(withSecret.connection).not.toHaveProperty("secretRef");
  });
});

describe("UpdateCapabilityProviderInputSchema", () => {
  const base = {
    workspace_id: workspaceId,
    expected_updated_at: "2026-07-17T10:00:00.000Z",
    type: "mcp_server" as const,
    provider: "Supabase",
    title: "Supabase",
    description: "Supabase tools",
    contract: {
      protocol: "mcp_streamable_http",
      tools: [{ name: "list_tables", inputSchema: { type: "object" } }],
    },
  };

  it("preserves an existing managed OAuth credential for metadata-only edits", () => {
    expect(UpdateCapabilityProviderInputSchema.safeParse({
      ...base,
      connection: {
        endpointUrl: "https://mcp.supabase.com/mcp?project_ref=project",
        authType: "oauth",
        credentialMode: "preserve",
        allowedHosts: ["mcp.supabase.com"],
      },
    }).success).toBe(true);
  });

  it("accepts the offset and microsecond timestamptz format returned by PostgREST", () => {
    expect(UpdateCapabilityProviderInputSchema.safeParse({
      ...base,
      expected_updated_at: "2026-07-17T10:00:00.123456+00:00",
      connection: {
        endpointUrl: "https://mcp.supabase.com/mcp?project_ref=project",
        authType: "oauth",
        credentialMode: "preserve",
        allowedHosts: ["mcp.supabase.com"],
      },
    }).success).toBe(true);
  });

  it("requires a fresh completed attempt when OAuth is replaced", () => {
    const connection = {
      endpointUrl: "https://mcp.supabase.com/mcp?project_ref=project",
      authType: "oauth" as const,
      credentialMode: "replace" as const,
      allowedHosts: ["mcp.supabase.com"],
    };
    expect(UpdateCapabilityProviderInputSchema.safeParse({ ...base, connection }).success).toBe(false);
    expect(UpdateCapabilityProviderInputSchema.safeParse({
      ...base,
      connection: {
        ...connection,
        oauthAttemptId: "55555555-5555-4555-8555-555555555555",
      },
    }).success).toBe(true);
  });

  it("never accepts a preserved credential together with a new secret", () => {
    expect(UpdateCapabilityProviderInputSchema.safeParse({
      ...base,
      connection: {
        endpointUrl: "https://mcp.example.com/mcp",
        authType: "bearer",
        credentialMode: "preserve",
        secret: "should-not-be-sent-when-preserving",
        allowedHosts: ["mcp.example.com"],
      },
    }).success).toBe(false);
  });

  it("asks for the secret again only when a static credential is replaced", () => {
    const connection = { endpointUrl: "https://mcp.example.com/mcp", authType: "bearer" as const, allowedHosts: ["mcp.example.com"] };
    expect(UpdateCapabilityProviderInputSchema.safeParse({ ...base, connection: { ...connection, credentialMode: "replace" } }).success).toBe(false);
    expect(UpdateCapabilityProviderInputSchema.safeParse({ ...base, connection: { ...connection, credentialMode: "replace", secret: "rotated" } }).success).toBe(true);
    expect(UpdateCapabilityProviderInputSchema.safeParse({ ...base, connection: { ...connection, credentialMode: "preserve" } }).success).toBe(true);
  });

  it("rejects an endpoint whose host is absent from the egress allowlist", () => {
    expect(UpdateCapabilityProviderInputSchema.safeParse({
      ...base,
      connection: {
        endpointUrl: "https://mcp.example.com/mcp",
        authType: "none",
        credentialMode: "replace",
        allowedHosts: ["example.com"],
      },
    }).success).toBe(false);
  });
});
describe("CreateGrantInputSchema", () => {
  it("requires exactly one capability or bundle target", () => {
    const base = {
      workspace_id: workspaceId,
      principal: {
        kind: "agent",
        source_type: "agent_token",
        source_id: "22222222-2222-4222-8222-222222222222",
        display_name: "deploy-agent",
      },
    };
    expect(CreateGrantInputSchema.safeParse(base).success).toBe(false);
    expect(CreateGrantInputSchema.safeParse({
      ...base,
      capability_id: "33333333-3333-4333-8333-333333333333",
      bundle_id: "44444444-4444-4444-8444-444444444444",
    }).success).toBe(false);
  });
});
