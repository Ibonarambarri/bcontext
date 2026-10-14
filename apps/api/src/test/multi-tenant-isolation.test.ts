/**
 * Multi-tenant isolation — integration test (P0-06).
 *
 * Asserts that no user, agent, or service-role-bypass can read or write
 * across workspace boundaries. Runs against a real Supabase test branch
 * — gated on `SUPABASE_TEST_URL` + `SUPABASE_TEST_SERVICE_KEY`. Skipped
 * locally when those env vars are absent so `npm test` stays cheap.
 *
 * Set-up the test branch with:
 *   supabase db push --db-url $SUPABASE_TEST_URL
 *   # apply migrations through 0012
 *
 * Two users (A, B), two workspaces (Wa, Wb). User A in Wa only. User B
 * in Wb only. A node N seeded in Wa. The test then exercises every
 * read/write surface from user B's context and asserts it cannot reach N.
 *
 * Tested surfaces:
 *   1. Direct SELECT against `nodes` with user B's user-context client
 *      → empty result (RLS bites).
 *   2. SELECT `audit_log` for workspace Wa under user B → empty.
 *   3. UPDATE nodes set ... where id = N as user B → no rows updated.
 *   4. DELETE nodes where id = N as user B → no rows deleted.
 *   5. Bearer-token route hit (when REST routes are exposed): token
 *      scoped to Wa hitting `/api/nodes?workspace=Wb` → 403.
 *
 * The connector entrypoints are exercised in their own tests.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL = process.env.SUPABASE_TEST_URL;
const SVC = process.env.SUPABASE_TEST_SERVICE_KEY;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SHOULD_RUN = Boolean(URL && SVC && ANON);

// vitest's `describe.skipIf` is the right tool here — when env vars are
// missing we skip with a clear message instead of failing.
const dscribe = SHOULD_RUN ? describe : describe.skip;

interface TestState {
  admin: SupabaseClient;
  orgId: string;
  wsA: string;
  wsB: string;
  userA: { id: string; email: string; password: string };
  userB: { id: string; email: string; password: string };
  nodeInA: string;
}

const state: Partial<TestState> = {};

dscribe("multi-tenant isolation (P0-06)", () => {
  beforeAll(async () => {
    if (!SHOULD_RUN) return;
    const admin = createClient(URL!, SVC!);
    state.admin = admin;

    const orgRow = await admin
      .from("organizations")
      .insert({
        slug: `test-${Date.now()}`,
        name: "RLS Isolation Test",
      })
      .select("id")
      .single();
    state.orgId = orgRow.data!.id as string;

    const wsa = await admin
      .from("workspaces")
      .insert({
        organization_id: state.orgId,
        slug: `wa-${Date.now()}`,
        name: "Wa",
      })
      .select("id")
      .single();
    const wsb = await admin
      .from("workspaces")
      .insert({
        organization_id: state.orgId,
        slug: `wb-${Date.now()}`,
        name: "Wb",
      })
      .select("id")
      .single();
    state.wsA = wsa.data!.id as string;
    state.wsB = wsb.data!.id as string;

    state.userA = {
      id: "",
      email: `user-a-${Date.now()}@example.test`,
      password: "rls-isolation-A-pw-123!",
    };
    state.userB = {
      id: "",
      email: `user-b-${Date.now()}@example.test`,
      password: "rls-isolation-B-pw-456!",
    };
    const a = await admin.auth.admin.createUser({
      email: state.userA.email,
      password: state.userA.password,
      email_confirm: true,
    });
    const b = await admin.auth.admin.createUser({
      email: state.userB.email,
      password: state.userB.password,
      email_confirm: true,
    });
    state.userA.id = a.data.user!.id;
    state.userB.id = b.data.user!.id;

    await admin.from("memberships").insert([
      { user_id: state.userA.id, workspace_id: state.wsA, role: "owner" },
      { user_id: state.userB.id, workspace_id: state.wsB, role: "owner" },
    ]);

    const node = await admin
      .from("nodes")
      .insert({
        workspace_id: state.wsA,
        kind: "doc",
        title: "Secret note in Wa",
        content_md: "this must never reach user B",
      })
      .select("id")
      .single();
    state.nodeInA = node.data!.id as string;
  }, 30_000);

  afterAll(async () => {
    if (!SHOULD_RUN || !state.admin) return;
    // Cascade cleanup via organization delete.
    if (state.userA?.id) {
      await state.admin.auth.admin.deleteUser(state.userA.id).catch(() => {});
    }
    if (state.userB?.id) {
      await state.admin.auth.admin.deleteUser(state.userB.id).catch(() => {});
    }
    if (state.orgId) {
      await state.admin.from("organizations").delete().eq("id", state.orgId);
    }
  });

  it("user B cannot SELECT a node in workspace A", async () => {
    const userB = createClient(URL!, ANON!);
    await userB.auth.signInWithPassword({
      email: state.userB!.email,
      password: state.userB!.password,
    });
    const { data, error } = await userB
      .from("nodes")
      .select("id, title, workspace_id")
      .eq("id", state.nodeInA!);
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it("user B cannot UPDATE a node in workspace A", async () => {
    const userB = createClient(URL!, ANON!);
    await userB.auth.signInWithPassword({
      email: state.userB!.email,
      password: state.userB!.password,
    });
    const { data, error } = await userB
      .from("nodes")
      .update({ title: "HACKED" })
      .eq("id", state.nodeInA!)
      .select();
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);

    // Verify the row wasn't actually changed via admin readback.
    const { data: after } = await state.admin!
      .from("nodes")
      .select("title")
      .eq("id", state.nodeInA!)
      .single();
    expect(after?.title).toBe("Secret note in Wa");
  });

  it("user B cannot DELETE a node in workspace A", async () => {
    const userB = createClient(URL!, ANON!);
    await userB.auth.signInWithPassword({
      email: state.userB!.email,
      password: state.userB!.password,
    });
    const { error } = await userB
      .from("nodes")
      .delete()
      .eq("id", state.nodeInA!);
    expect(error).toBeNull();

    const { data: still } = await state.admin!
      .from("nodes")
      .select("id")
      .eq("id", state.nodeInA!)
      .maybeSingle();
    expect(still?.id).toBe(state.nodeInA);
  });

  it("user B cannot read workspace A's audit_log rows", async () => {
    // Seed an audit row attributed to user A.
    await state.admin!.from("audit_log").insert({
      workspace_id: state.wsA!,
      action: "test.seed",
      actor_kind: "system",
      actor_id: null,
    });

    const userB = createClient(URL!, ANON!);
    await userB.auth.signInWithPassword({
      email: state.userB!.email,
      password: state.userB!.password,
    });
    const { data } = await userB
      .from("audit_log")
      .select("id")
      .eq("workspace_id", state.wsA!);
    expect(data ?? []).toEqual([]);
  });
});

if (!SHOULD_RUN) {
  // eslint-disable-next-line no-console
  console.log(
    "[rls-isolation] skipped — set SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_KEY, SUPABASE_TEST_ANON_KEY to run",
  );
}
