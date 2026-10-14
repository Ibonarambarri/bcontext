/**
 * Group: /.well-known/*, /api/health, /llms.txt, /install/*.
 *
 * Unauthenticated discovery documents — and the one group where the *path*
 * is the risk: dots in segments (`agents.json`, `llms.txt`),
 * which some routers treat as extensions. Parity here is mostly proof that
 * Hono matches them literally.
 */
import { describe, expect, it } from "vitest";
import { createApiApp } from "../app";
import { assertParity } from "./harness";
import * as agentsJson from "@/app/.well-known/agents.json/route";
import * as authServer from "@/app/.well-known/oauth-authorization-server/route";
import * as protectedResource from "@/app/.well-known/oauth-protected-resource/route";
import * as protectedWorkspaceModule from "@/app/.well-known/oauth-protected-resource/mcp/[org]/[workspace]/route";
import type { RouteModule } from "../adapter";
import * as health from "@/app/api/health/route";
import * as llms from "@/app/llms.txt/route";
import * as installMcp from "@/app/install/mcp/route";

const app = createApiApp({ serve: ["/.well-known", "/api/health", "/llms.txt", "/install"] });
// Typed params are narrower than the adapter's `Record<string, string>`; the
// generated table casts for the same reason.
const protectedWorkspace = protectedWorkspaceModule as unknown as RouteModule;

describe("parity: discovery documents", () => {
  it("/.well-known/agents.json", () => assertParity(app, agentsJson, { method: "GET", path: "/.well-known/agents.json" }));
  it("/.well-known/oauth-authorization-server", () =>
    assertParity(app, authServer, { method: "GET", path: "/.well-known/oauth-authorization-server" }));
  it("/.well-known/oauth-protected-resource", () =>
    assertParity(app, protectedResource, { method: "GET", path: "/.well-known/oauth-protected-resource" }));
  it("/.well-known/oauth-protected-resource/mcp/:org/:workspace", async () => {
    const direct = await assertParity(app, protectedWorkspace, {
      method: "GET",
      path: "/.well-known/oauth-protected-resource/mcp/acme/docs",
      params: { org: "acme", workspace: "docs" },
    });
    expect(direct.status).toBe(200);
    expect((direct.body as { resource: string }).resource).toMatch(/\/mcp\/acme\/docs$/);
  });
  it("/.well-known/oauth-protected-resource/mcp/:org/:workspace (malformed pair)", () =>
    assertParity(app, protectedWorkspace, {
      method: "GET",
      path: "/.well-known/oauth-protected-resource/mcp/acme/docs%20x",
      params: { org: "acme", workspace: "docs x" },
    }));
  it("/api/health", () => assertParity(app, health, { method: "GET", path: "/api/health" }));
  it("/llms.txt", () => assertParity(app, llms, { method: "GET", path: "/llms.txt" }));
  it("/install/mcp", () => assertParity(app, installMcp, { method: "GET", path: "/install/mcp" }));
});
