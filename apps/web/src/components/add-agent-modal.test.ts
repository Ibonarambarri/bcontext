import { describe, expect, it } from "vitest";
import { agentConfig, stepsForMethod } from "./add-agent-modal";
import type { McpTarget } from "@/lib/mcp-endpoint";

const ENDPOINT = "https://your-bcontext.example/mcp/acme/docs";
const NAME = "bcontext-acme-docs";
const TARGET: McpTarget = { endpoint: ENDPOINT, serverName: NAME };

describe("Add agent step sequence", () => {
  it("keeps the OAuth branch minimal — configuration happens on the consent screen", () => {
    expect(stepsForMethod("oauth")).toEqual(["Method", "Connect"]);
  });

  it("collects the full configuration up front for API keys", () => {
    expect(stepsForMethod("token")).toEqual(["Method", "Provider", "Configure", "Connect"]);
  });
});

describe("Add agent configuration", () => {
  it("keeps the Bcontext client endpoint separate from external tool providers", () => {
    expect(agentConfig("openai", "oauth", TARGET)).toContain(`codex mcp add ${NAME}`);
    expect(agentConfig("openai", "token", TARGET)).toContain("BCONTEXT_MCP_TOKEN");
  });

  it("uses the claude CLI for Claude Code", () => {
    expect(agentConfig("claude-code", "oauth", TARGET)).toBe(
      `claude mcp add --transport http ${NAME} ${ENDPOINT}`,
    );
    expect(agentConfig("claude-code", "token", TARGET)).toContain("Authorization: Bearer");
  });

  it("provides generic MCP JSON for runtimes without a dedicated command", () => {
    const config = agentConfig("custom", "token", TARGET);
    expect(config).toContain('"mcpServers"');
    expect(config).toContain("Bearer YOUR_TOKEN");
    const oauthConfig = agentConfig("custom", "oauth", TARGET);
    expect(oauthConfig).toContain('"mcpServers"');
    expect(oauthConfig).not.toContain("Authorization");
  });

  it("targets each provider's own config surface", () => {
    expect(agentConfig("cursor", "oauth", TARGET)).toContain(".cursor/mcp.json");
    expect(agentConfig("windsurf", "oauth", TARGET)).toContain("mcp_config.json");
    expect(agentConfig("zed", "oauth", TARGET)).toContain("context_servers");
    expect(agentConfig("gemini-cli", "oauth", TARGET)).toContain("gemini mcp add");
    expect(agentConfig("vscode", "oauth", TARGET)).toContain("code --add-mcp");
    expect(agentConfig("github-copilot", "oauth", TARGET)).toContain(".vscode/mcp.json");
    expect(agentConfig("goose", "oauth", TARGET)).toContain("goose configure");
  });

  it("always embeds the workspace endpoint and files the server per workspace", () => {
    const slugs = [
      "claude-code", "claude", "cursor", "windsurf", "zed", "gemini-cli", "github-copilot",
      "vscode", "openai", "cline", "goose", "raycast", "custom",
    ];
    for (const slug of slugs) {
      const config = agentConfig(slug, "oauth", TARGET);
      expect(config, slug).toContain(ENDPOINT);
      expect(config, slug).toContain(NAME);
      // The name is per workspace so two project folders never collide.
      expect(config, slug).not.toMatch(/"bcontext"\s*:/);
    }
  });

  it("embeds a freshly minted token into every placeholder", () => {
    const token = "bctx_live_test123";
    expect(agentConfig("custom", "token", TARGET, token)).toContain(token);
    expect(agentConfig("custom", "token", TARGET, token)).not.toContain("YOUR_TOKEN");
    expect(agentConfig("claude-code", "token", TARGET, token)).toContain(token);
    expect(agentConfig("claude-code", "token", TARGET, token)).not.toContain("BCONTEXT_MCP_TOKEN");
    // Codex keeps the env-var *name* but exports the real token into it.
    expect(agentConfig("openai", "token", TARGET, token)).toContain(`export BCONTEXT_MCP_TOKEN=${token}`);
  });

  it("never leaks a token into OAuth snippets", () => {
    expect(agentConfig("claude-code", "oauth", TARGET, "bctx_live_test123")).toBe(
      `claude mcp add --transport http ${NAME} ${ENDPOINT}`,
    );
  });
});
