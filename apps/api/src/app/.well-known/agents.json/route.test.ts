import { describe, expect, test } from "vitest";
import { GET } from "./route";

describe("/.well-known/agents.json", () => {
  test("advertises the H2 content-block convention", async () => {
    const req = new Request("https://example.com/.well-known/agents.json");
    const res = await GET(req as unknown as Request);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conventions?: {
        content_blocks?: { rule?: string; rationale?: string };
      };
    };
    const rule = body.conventions?.content_blocks?.rule;
    expect(typeof rule).toBe("string");
    // Soft contract: the rule must mention H2 + addressable blocks so any
    // agent scanning this manifest learns the convention without further
    // reading.
    expect(rule).toMatch(/H2/);
    expect(rule).toMatch(/##/);
    expect(rule).toMatch(/block/i);
    expect(body.conventions?.content_blocks?.rationale).toMatch(/\w+/);
  });

  test("advertises the grouped tag tools and their security boundary", async () => {
    const req = new Request("https://example.com/.well-known/agents.json");
    const res = await GET(req as unknown as Request);
    const body = (await res.json()) as {
      mcp?: { tools?: string[] };
      conventions?: { taxonomy?: { rule?: string; rationale?: string } };
    };

    expect(body.mcp?.tools).toEqual(
      expect.arrayContaining(["tags", "tags_write", "nodes", "nodes_write"]),
    );
    expect(body.conventions?.taxonomy?.rule).toMatch(/kind.*primary/i);
    expect(body.conventions?.taxonomy?.rule).toMatch(/folder and category are not node fields/i);
    expect(body.conventions?.taxonomy?.rule).toMatch(/parent_id.*real hierarchy/i);
    expect(body.conventions?.taxonomy?.rule).toMatch(/RLS/i);
    expect(body.conventions?.taxonomy?.rationale).toMatch(/without duplicating/i);
  });

  test("states the surface decision: MCP for agents, REST for humans and automations", async () => {
    const req = new Request("https://example.com/.well-known/agents.json");
    const res = await GET(req as unknown as Request);
    const body = (await res.json()) as {
      surfaces?: { agents?: string; humans_and_automations?: string };
      mcp?: { audience?: string };
      rest?: { audience?: string; note?: string; endpoints?: unknown[] };
    };
    expect(body.surfaces).toMatchObject({ agents: "mcp", humans_and_automations: "rest" });
    expect(body.mcp?.audience).toBe("agents");
    expect(body.rest?.audience).toBe("humans-and-automations");
    expect(body.rest?.note).toMatch(/not an agent surface/i);
    // Nothing removed: the REST endpoints are still listed for the automations that use them.
    expect(body.rest?.endpoints?.length).toBeGreaterThan(0);
  });
});
