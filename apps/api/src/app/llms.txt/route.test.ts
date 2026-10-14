import { describe, expect, test } from "vitest";
import { GET } from "./route";

describe("/llms.txt", () => {
  test("tells an agent to use MCP and frames REST as the human/automation surface", async () => {
    const res = await GET(new Request("https://example.com/llms.txt") as unknown as Request);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toContain("https://example.com/mcp");
    expect(body).toMatch(/MCP is the agent surface/);
    expect(body).toMatch(/REST \(\/api\/\*\) is for humans and for automations/);
    expect(body).toMatch(/no longer advertised to agents/);
    // Nothing removed: the compatibility endpoints are still documented.
    expect(body).toContain("/api/agents/context");
    expect(body).toContain("/api/agents/write");
  });
});
