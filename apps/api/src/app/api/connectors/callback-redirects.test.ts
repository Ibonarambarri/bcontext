/**
 * OAuth callbacks land the browser on the web app, not on whatever origin
 * the request arrived on. In production the provider redirects to
 * `${APP_URL}/api/connectors/<x>/callback`, the web app proxies `/api/*` to
 * the API, and the handler sees the API's own origin in `req.url`; a
 * redirect built from it would strand the user off the app.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as github } from "./github/callback/route";
import { GET as linear } from "./linear/callback/route";
import { GET as notion } from "./notion/callback/route";
import { GET as slack } from "./slack/callback/route";

const APP = "https://app.example.dev";
const API = "https://api.example.dev";
const saved = { APP_URL: process.env.APP_URL, NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL };

beforeEach(() => {
  process.env.APP_URL = APP;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const ctx = { params: Promise.resolve({}) };

// Missing `code`/`state` is the first guard in every handler, so the redirect
// is decided before any database access and the test needs no Supabase.
const cases: Array<[string, (req: Request, c: typeof ctx) => Promise<Response>, string]> = [
  ["slack", slack, "/?slack=invalid"],
  ["linear", linear, "/?linear=invalid"],
  ["notion", notion, "/?notion=invalid"],
  ["github", github, "/?github=invalid"],
];

describe("connector OAuth callbacks", () => {
  for (const [name, handler, expectedPath] of cases) {
    it(`${name}: redirects to the app origin, not the request origin`, async () => {
      const res = await handler(new Request(`${API}/api/connectors/${name}/callback`), ctx);
      expect(res.status).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.origin).toBe(APP);
      expect(`${location.pathname}${location.search}`).toBe(expectedPath);
    });
  }
});
