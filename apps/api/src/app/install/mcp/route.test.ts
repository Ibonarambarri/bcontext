import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function served(url: string): Promise<string> {
  const res = await GET(new Request(url));
  expect(res.status).toBe(200);
  return res.text();
}

describe("GET /install/mcp", () => {
  it("stamps the configured app's MCP endpoint into the script", async () => {
    vi.stubEnv("APP_URL", "https://ctx.acme.test/");
    const body = await served("http://api:4000/install/mcp");
    expect(body).toContain('const SERVED_URL = "https://ctx.acme.test/mcp";');
    expect(body).not.toContain("__BCONTEXT_MCP_URL__");
  });

  it("falls back to the request's own origin", async () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    const body = await served("https://bx.self.test/install/mcp");
    expect(body).toContain('const SERVED_URL = "https://bx.self.test/mcp";');
  });
});
