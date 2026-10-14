import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace } from "@/lib/demo-store";

/**
 * The guide is for people: a demo actor (the dev escape hatch) and a bearer
 * token are both turned away, a signed-in member gets the steps. The demo
 * backend has nothing an agent could have done, so every step is pending
 * there; the Supabase reads are covered by `@/lib/onboarding/facts.test.ts`.
 * The dismissal is exercised against a fake admin client that records what
 * `updateUserById` is handed, since merging is the whole point of it.
 */
let sessionUser: { id: string; user_metadata?: Record<string, unknown> } | null = null;
let stored: Record<string, unknown> = {};
const updates: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { user_metadata: stored } } }),
        updateUserById: async (_id: string, patch: { user_metadata: Record<string, unknown> }) => {
          updates.push(patch.user_metadata);
          stored = patch.user_metadata;
          return { data: {}, error: null };
        },
      },
    },
  }),
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { GET } from "./route";
import { POST as DISMISS } from "./dismiss/route";

const headers = { origin: "http://localhost", host: "localhost" };
const get = (slug: string) => GET(new Request(`http://localhost/api/onboarding?workspace=${slug}`, { headers }));
const dismiss = () => DISMISS(new Request("http://localhost/api/onboarding/dismiss", { method: "POST", headers }));

afterEach(() => {
  sessionUser = null;
  stored = {};
  updates.length = 0;
});

describe("GET /api/onboarding", () => {
  it("wants a workspace", async () => {
    sessionUser = { id: "u-1" };
    expect((await GET(new Request("http://localhost/api/onboarding", { headers }))).status).toBe(400);
  });

  it("turns a demo actor away: the guide belongs to a person", async () => {
    const ws = createWorkspace({ name: "Guide", slug: `guide-${Date.now()}` });
    expect((await get(ws.slug)).status).toBe(401);
  });

  it("answers a member with every step pending on the demo backend", async () => {
    sessionUser = { id: "u-1" };
    const ws = createWorkspace({ name: "Guide", slug: `guide-${Date.now()}-b` });
    const res = await get(ws.slug);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: ws.slug,
      steps: [
        { id: "connect_agent", done: false },
        { id: "first_agent_write", done: false },
        { id: "ask_nexo", done: false },
        { id: "connect_integration", done: false },
      ],
      completed: false,
      dismissed_at: null,
    });
  });
});

describe("POST /api/onboarding/dismiss", () => {
  it("is a 401 without a session", async () => {
    expect((await dismiss()).status).toBe(401);
  });

  it("stamps the dismissal without dropping the rest of the metadata", async () => {
    sessionUser = { id: "u-1" };
    stored = { first_name: "Ana", signup_complete: true };
    const res = await dismiss();
    expect(res.status).toBe(200);
    const { dismissed_at } = (await res.json()) as { dismissed_at: string };
    expect(Number.isNaN(Date.parse(dismissed_at))).toBe(false);
    expect(updates).toEqual([{ first_name: "Ana", signup_complete: true, onboarding_dismissed_at: dismissed_at }]);
  });

  it("keeps the first stamp on a second dismissal", async () => {
    sessionUser = { id: "u-1" };
    stored = { onboarding_dismissed_at: "2026-09-01T00:00:00.000Z" };
    const res = await dismiss();
    expect(await res.json()).toEqual({ dismissed_at: "2026-09-01T00:00:00.000Z" });
    expect(updates).toHaveLength(0);
  });
});
