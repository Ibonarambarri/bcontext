import { describe, expect, it } from "vitest";
import { mcpServerName, parseMcpResource, workspaceMcpEndpoint } from "./mcp-endpoint";

const ORIGIN = "https://your-bcontext.example";

describe("workspace MCP endpoint", () => {
  it("builds <origin>/mcp/<org>/<workspace>", () => {
    expect(workspaceMcpEndpoint(ORIGIN, { org: "acme", slug: "docs" })).toBe(
      "https://your-bcontext.example/mcp/acme/docs",
    );
    expect(workspaceMcpEndpoint(`${ORIGIN}/`, { org: "acme", slug: "docs" })).toBe(
      "https://your-bcontext.example/mcp/acme/docs",
    );
  });

  it("names the client config entry per workspace", () => {
    expect(mcpServerName({ org: "acme", slug: "docs" })).toBe("bcontext-acme-docs");
  });

  it("round-trips through the resource parser", () => {
    const ws = { org: "acme", slug: "docs" };
    expect(parseMcpResource(workspaceMcpEndpoint(ORIGIN, ws), ORIGIN)).toEqual({
      kind: "workspace",
      ...ws,
    });
  });
});

describe("parseMcpResource", () => {
  it("reads a workspace endpoint", () => {
    expect(parseMcpResource(`${ORIGIN}/mcp/acme/docs`, ORIGIN)).toEqual({
      kind: "workspace",
      org: "acme",
      slug: "docs",
    });
  });

  it("recognises the root endpoint", () => {
    expect(parseMcpResource(`${ORIGIN}/mcp`, ORIGIN)).toEqual({ kind: "root" });
    expect(parseMcpResource(`${ORIGIN}/mcp/`, ORIGIN)).toEqual({ kind: "root" });
  });

  it("ignores a trailing slash, a query and a fragment", () => {
    for (const noise of ["/", "?x=1", "#frag", "/?x=1#frag"]) {
      expect(parseMcpResource(`${ORIGIN}/mcp/acme/docs${noise}`, ORIGIN)).toEqual({
        kind: "workspace",
        org: "acme",
        slug: "docs",
      });
    }
  });

  it("tolerates a trailing slash on the app origin", () => {
    expect(parseMcpResource(`${ORIGIN}/mcp/acme/docs`, `${ORIGIN}/`)).toEqual({
      kind: "workspace",
      org: "acme",
      slug: "docs",
    });
  });

  it("rejects a foreign origin", () => {
    expect(parseMcpResource("https://evil.example/mcp/acme/docs", ORIGIN)).toBeNull();
    expect(parseMcpResource("http://your-bcontext.example/mcp/acme/docs", ORIGIN)).toBeNull();
    expect(parseMcpResource("https://your-bcontext.example:8443/mcp", ORIGIN)).toBeNull();
  });

  it("rejects garbage and paths that are not an endpoint", () => {
    expect(parseMcpResource(undefined, ORIGIN)).toBeNull();
    expect(parseMcpResource(null, ORIGIN)).toBeNull();
    expect(parseMcpResource("", ORIGIN)).toBeNull();
    expect(parseMcpResource("not a url", ORIGIN)).toBeNull();
    expect(parseMcpResource("/mcp/acme/docs", ORIGIN)).toBeNull();
    expect(parseMcpResource(`${ORIGIN}/api/mcp`, ORIGIN)).toBeNull();
    expect(parseMcpResource(`${ORIGIN}/mcp/acme`, ORIGIN)).toBeNull();
    expect(parseMcpResource(`${ORIGIN}/mcp/acme/docs/extra`, ORIGIN)).toBeNull();
    expect(parseMcpResource(`${ORIGIN}/mcp/a%20b/docs`, ORIGIN)).toBeNull();
  });

  it("is null when the app origin itself is not a URL", () => {
    expect(parseMcpResource(`${ORIGIN}/mcp`, "")).toBeNull();
  });
});
