import { describe, expect, it } from "vitest";
import { detectAgentProvider, normalizeRole, scopesForRole } from "./connections.js";

describe("agent connections", () => {
  it("detects known MCP clients without trusting them for permissions", () => {
    expect(detectAgentProvider("Claude Code")).toBe("claude_code");
    expect(detectAgentProvider("Open Claw local")).toBe("openclaw");
    expect(detectAgentProvider("Unknown client")).toBe("other");
  });

  it("never grants a preset scope the client did not request", () => {
    expect(scopesForRole("operator", ["nodes:read", "chat:run"])).toEqual([
      "nodes:read",
      "chat:run",
    ]);
  });

  it("filters invalid custom scopes through the canonical parser", () => {
    expect(scopesForRole("custom", ["nodes:read"], ["nodes:read", "admin:*"])).toEqual([
      "nodes:read",
    ]);
  });

  it("keeps a submitted role only when the scopes match its preset exactly", () => {
    expect(
      normalizeRole("observer", ["nodes:read", "agents:read"]),
    ).toBe("observer");
    expect(normalizeRole("observer", ["nodes:read"])).toBe("custom");
    expect(normalizeRole("operator", ["nodes:read", "nodes:write"])).toBe("custom");
    expect(normalizeRole("custom", ["nodes:read"])).toBe("custom");
  });

  it("derives the role from scopes when none is submitted", () => {
    expect(normalizeRole(undefined, ["nodes:read", "agents:read"])).toBe("observer");
    expect(normalizeRole(null, ["nodes:read", "nodes:write"])).toBe("collaborator");
    expect(normalizeRole(undefined, ["chat:run"])).toBe("operator");
  });
});
