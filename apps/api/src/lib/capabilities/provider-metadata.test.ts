import { describe, expect, it } from "vitest";
import { inferProviderMetadata, providerNameFromHost } from "./provider-metadata";

describe("provider metadata inference", () => {
  it("anchors identity to the endpoint and separates initialize claims", () => {
    expect(inferProviderMetadata(new URL("https://mcp.supabase.com/mcp"), {
      name: "supabase-mcp",
      title: "Supabase",
      description: "Manage a Supabase project through MCP.",
      version: "1.2.3",
    })).toEqual({
      title: "Supabase",
      name: "Supabase",
      description: "Supabase MCP server at mcp.supabase.com",
      endpointHost: "mcp.supabase.com",
      identitySource: "endpoint_host",
      declared: {
        title: "Supabase",
        name: "Supabase Mcp",
        description: "Manage a Supabase project through MCP.",
        version: "1.2.3",
      },
    });
  });

  it("falls back to a human provider name from the endpoint", () => {
    expect(inferProviderMetadata(new URL("https://mcp.context7.com/mcp"), {
      name: "mcp-server",
      version: "0.1.0",
    })).toEqual({
      title: "Context7",
      name: "Context7",
      description: "Context7 MCP server at mcp.context7.com",
      endpointHost: "mcp.context7.com",
      identitySource: "endpoint_host",
      declared: { name: "Mcp Server", version: "0.1.0" },
    });
  });

  it("normalizes common MCP host prefixes", () => {
    expect(providerNameFromHost("api.mcp.acme-tools.io")).toBe("Acme Tools");
    expect(providerNameFromHost("mcp.supabase.com")).toBe("Supabase");
    expect(providerNameFromHost("mcp.data-cloud.co.uk")).toBe("Data Cloud");
  });

  it("bounds untrusted server descriptions", () => {
    const metadata = inferProviderMetadata(new URL("https://tools.example.com/mcp"), {
      name: "example",
      version: "1",
      description: `  ${"x".repeat(600)}  `,
    });
    expect(metadata.declared?.description).toHaveLength(500);
  });

  it("does not let a remote server impersonate a known provider", () => {
    const metadata = inferProviderMetadata(new URL("https://mcp.attacker.example/mcp"), {
      name: "supabase-mcp",
      title: "Supabase",
      description: "Official Supabase endpoint",
      version: "1",
    });
    expect(metadata).toMatchObject({
      title: "Attacker",
      name: "Attacker",
      endpointHost: "mcp.attacker.example",
      identitySource: "endpoint_host",
      declared: { title: "Supabase" },
    });
  });

  it("strips invisible and bidi formatting from declared metadata", () => {
    const metadata = inferProviderMetadata(new URL("https://mcp.example.com/mcp"), {
      name: "safe\u2066evil\u2069",
      title: "Git\u202eHub",
      description: "hello\u200b world\u061c",
      version: "1\u200f.2",
    });
    expect(metadata.declared).toEqual({
      title: "GitHub",
      name: "Safeevil",
      description: "hello world",
      version: "1.2",
    });
  });
});
