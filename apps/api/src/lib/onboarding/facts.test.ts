import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readOnboardingFacts } from "./facts";

/**
 * A recording stand-in for the admin client: each `from(table)` returns a
 * builder that remembers its filters and resolves to the count the test
 * assigned to that table. Enough to prove which table answers which fact
 * and that every fact is scoped to the workspace.
 */
interface Call {
  table: string;
  filters: string[];
}

function fakeAdmin(counts: Record<string, number | null>, failing?: string) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, filters: [] };
    calls.push(call);
    const builder = {
      select: () => builder,
      eq: (col: string, v: unknown) => (call.filters.push(`${col}=${String(v)}`), builder),
      neq: (col: string, v: unknown) => (call.filters.push(`${col}!=${String(v)}`), builder),
      is: (col: string, v: unknown) => (call.filters.push(`${col} is ${String(v)}`), builder),
      then: (resolve: (r: { count: number | null; error: { message: string } | null }) => void) =>
        resolve(
          table === failing
            ? { count: null, error: { message: "boom" } }
            : { count: counts[table] ?? 0, error: null },
        ),
    };
    return builder;
  };
  return { admin: { from } as unknown as SupabaseClient, calls };
}

const subject = { workspaceId: "ws-1", userId: "u-1" };

describe("readOnboardingFacts", () => {
  it("answers each step from its own table, scoped to the workspace", async () => {
    const { admin, calls } = fakeAdmin({
      agent_workspace_access: 1,
      activity: 0,
      chat_sessions: 2,
      connector_installs: 0,
    });
    const facts = await readOnboardingFacts(admin, subject);
    expect(facts).toEqual({
      connect_agent: true,
      first_agent_write: false,
      ask_nexo: true,
      connect_integration: false,
    });
    for (const call of calls) expect(call.filters).toContain("workspace_id=ws-1");
    expect(calls.find((c) => c.table === "agent_workspace_access")?.filters).toContain("revoked_at is null");
    expect(calls.find((c) => c.table === "activity")?.filters).toContain("actor_kind=agent");
    expect(calls.find((c) => c.table === "chat_sessions")?.filters).toContain("user_id=u-1");
    expect(calls.find((c) => c.table === "connector_installs")?.filters).toContain("status!=uninstalled");
  });

  it("treats a null count as nothing done rather than as done", async () => {
    const { admin } = fakeAdmin({ activity: null });
    const facts = await readOnboardingFacts(admin, subject);
    expect(facts.first_agent_write).toBe(false);
  });

  it("fails loudly when a fact cannot be read, naming the fact", async () => {
    const { admin } = fakeAdmin({}, "chat_sessions");
    await expect(readOnboardingFacts(admin, subject)).rejects.toThrow(/ask_nexo: boom/);
  });
});
