import { describe, expect, it } from "vitest";
import { agentInstructions, rulesFileFor } from "./agent-instructions";

const TARGET = { endpoint: "https://your-bcontext.example/mcp/acme/docs", serverName: "bcontext-acme-docs" };
const ADDRESS = { org: "acme", slug: "docs" };

describe("rules file per runtime", () => {
  it("names the file each runtime reads at session start", () => {
    expect(rulesFileFor("claude-code").path).toBe("CLAUDE.md");
    expect(rulesFileFor("cursor").path).toBe(".cursor/rules/bcontext.mdc");
    expect(rulesFileFor("gemini-cli").path).toBe("GEMINI.md");
    expect(rulesFileFor("github-copilot").path).toBe(".github/copilot-instructions.md");
    expect(rulesFileFor("cline").path).toBe(".clinerules");
  });

  it("falls back to AGENTS.md, the cross-vendor default", () => {
    expect(rulesFileFor("openai").path).toBe("AGENTS.md");
    expect(rulesFileFor("zed").path).toBe("AGENTS.md");
    expect(rulesFileFor("custom").path).toBe("AGENTS.md");
  });
});

describe("agent instructions", () => {
  it("bakes the workspace address and server name in", () => {
    const md = agentInstructions(TARGET, ADDRESS);
    expect(md).toContain("**acme/docs**");
    expect(md).toContain("`bcontext-acme-docs`");
    expect(md).toContain(TARGET.endpoint);
  });

  it("teaches the session loop the plugin skill teaches", () => {
    const md = agentInstructions(TARGET, ADDRESS);
    for (const term of ["`brief`", "ask_nexo", "in_progress", "subtasks", "Result", "if_updated_at", "links_write", "list_changes"]) {
      expect(md, term).toContain(term);
    }
  });

  it("starts with the markdown title unless the runtime wants frontmatter", () => {
    expect(agentInstructions(TARGET, ADDRESS, "claude-code").startsWith("# Bcontext")).toBe(true);
    const cursor = agentInstructions(TARGET, ADDRESS, "cursor");
    expect(cursor.startsWith("---\n")).toBe(true);
    expect(cursor).toContain("alwaysApply: true");
    expect(cursor).toContain("# Bcontext");
  });
});
