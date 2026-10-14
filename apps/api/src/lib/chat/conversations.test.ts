/**
 * The general Nexo's history (`/api/nexo/conversations`) lists only
 * conversations with no `nexo_id`: a specialist's chats belong to its own
 * page. A new conversation carries the Nexo it is with, and none for the
 * general one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ log: [] as Array<[string, unknown[]]> }));
vi.mock("@/lib/supabase/admin", () => {
  const builder: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "is", "order", "limit", "insert", "single"]) {
    builder[m] = (...args: unknown[]) => {
      calls.log.push([m, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: calls.log.some(([m]) => m === "insert") ? { id: "c1", workspace_id: "w1", created_at: "now" } : [], error: null });
  return { getSupabaseAdmin: () => builder };
});

import { createConversation, listConversations } from "./conversations";

beforeEach(() => {
  calls.log = [];
});

describe("conversations", () => {
  it("lists only the general Nexo's conversations", async () => {
    await listConversations("w1", "u1");
    expect(calls.log).toContainEqual(["is", ["nexo_id", null]]);
  });

  it("stamps a specialist's conversation with its nexo_id and leaves the general one null", async () => {
    await createConversation("w1", "u1", "hola", "n1");
    expect(calls.log.find(([m]) => m === "insert")?.[1][0]).toMatchObject({ nexo_id: "n1" });
    calls.log = [];
    await createConversation("w1", "u1", "hola");
    expect(calls.log.find(([m]) => m === "insert")?.[1][0]).not.toHaveProperty("nexo_id");
  });
});
