/**
 * The enqueue happens in the same transaction as the write that causes it.
 *
 * `emitEvent` has two paths. Without `DATABASE_URL` it keeps the original
 * behaviour (insert via PostgREST, fire-and-forget POST) — covered by
 * dispatch.test.ts. With `DATABASE_URL` it writes the delivery rows and the
 * pg-boss job through one transaction, which is what this file pins down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  enqueue: vi.fn(async () => "job-1"),
}));

vi.mock("@/lib/queue/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/queue/db")>(
    "@/lib/queue/db",
  );
  return { ...actual, withTransaction: mocks.withTransaction };
});
vi.mock("@/lib/queue/producers", () => ({ enqueue: mocks.enqueue }));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { emitEvent } from "./dispatch";
import { QUEUE_WEBHOOK_DRAIN } from "@/lib/queue/queues";

const ENDPOINTS = [
  {
    id: "ep-1",
    url: "https://a.example/hook",
    event_types: ["node.created"],
    secret_hash: "s1",
    paused: false,
  },
  {
    id: "ep-2",
    url: "https://b.example/hook",
    event_types: ["*"],
    secret_hash: "s2",
    paused: false,
  },
];

function adminWithEndpoints(rows: unknown[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: async () => ({ data: rows, error: null }),
        }),
      }),
    }),
  } as never;
}

/** Records every statement the emit path runs through the transaction. */
function fakeTx() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  return {
    statements,
    tx: {
      executeSql: async (sql: string, values: unknown[] = []) => {
        statements.push({ sql, values });
        return { rows: [{ id: `del-${statements.length}` }] };
      },
    },
  };
}

const prev = process.env.DATABASE_URL;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://user@host/db";
  mocks.enqueue.mockClear();
  mocks.enqueue.mockResolvedValue("job-1");
  mocks.withTransaction.mockReset();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
  if (prev === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prev;
});

describe("emitEvent — transactional path", () => {
  it("writes the delivery rows and the drain job through one transaction", async () => {
    const { statements, tx } = fakeTx();
    mocks.withTransaction.mockImplementation(
      async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );

    const result = await emitEvent(adminWithEndpoints(ENDPOINTS), {
      workspaceId: "ws-1",
      workspaceSlug: "acme",
      type: "node.created",
      data: { id: "n1" },
    });

    expect(result).toEqual({ enqueued: 2, matched: 2 });
    expect(statements).toHaveLength(2);
    for (const s of statements) {
      expect(s.sql).toContain("insert into webhook_deliveries");
      // next_retry_at = now() so the drain (pg-boss `webhook.drain`) sees
      // the row on its very next pass.
      expect(s.sql).toContain("now()");
      expect(s.values[1]).toBe("ws-1");
    }
    // Same `tx` object → same transaction as the inserts.
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const [name, , opts] = mocks.enqueue.mock.calls[0] as unknown as [
      string,
      unknown,
      { tx: unknown; singletonKey: string },
    ];
    expect(name).toBe(QUEUE_WEBHOOK_DRAIN);
    expect(opts.tx).toBe(tx);
    expect(opts.singletonKey).toBe("emit");
  });

  it("does not POST from the request when the worker owns delivery", async () => {
    const { tx } = fakeTx();
    mocks.withTransaction.mockImplementation(
      async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    await emitEvent(adminWithEndpoints(ENDPOINTS), {
      workspaceId: "ws-1",
      workspaceSlug: "acme",
      type: "node.created",
      data: {},
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips the enqueue entirely when no endpoint matched", async () => {
    await emitEvent(adminWithEndpoints([ENDPOINTS[0]!]), {
      workspaceId: "ws-1",
      workspaceSlug: "acme",
      type: "node.deleted",
      data: {},
    });
    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("reports nothing enqueued when the transaction aborts", async () => {
    // A rollback means neither the rows nor the job exist — emitEvent must
    // not claim otherwise, and must not break the caller's own write.
    mocks.withTransaction.mockRejectedValue(new Error("rollback"));
    const result = await emitEvent(adminWithEndpoints(ENDPOINTS), {
      workspaceId: "ws-1",
      workspaceSlug: "acme",
      type: "node.created",
      data: {},
    });
    expect(result).toEqual({ enqueued: 0, matched: 0 });
  });

  it("aborts the whole emit when the in-transaction enqueue fails", async () => {
    const { statements, tx } = fakeTx();
    // Real withTransaction semantics: the callback throwing rolls back.
    mocks.withTransaction.mockImplementation(
      async (fn: (t: unknown) => Promise<unknown>) => {
        try {
          return await fn(tx);
        } catch (err) {
          statements.push({ sql: "ROLLBACK", values: [] });
          throw err;
        }
      },
    );
    mocks.enqueue.mockRejectedValueOnce(new Error("job insert failed"));

    const result = await emitEvent(adminWithEndpoints(ENDPOINTS), {
      workspaceId: "ws-1",
      workspaceSlug: "acme",
      type: "node.created",
      data: {},
    });

    expect(result).toEqual({ enqueued: 0, matched: 0 });
    expect(statements.at(-1)!.sql).toBe("ROLLBACK");
  });
});

describe("emitEvent — legacy path", () => {
  it("never touches the transaction when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
    const admin = {
      from: (table: string) => {
        if (table === "webhook_endpoints") {
          return {
            select: () => ({ eq: () => ({ eq: async () => ({ data: ENDPOINTS, error: null }) }) }),
            update: () => ({ eq: async () => ({}) }),
          };
        }
        return {
          insert: () => ({
            select: () => ({ single: async () => ({ data: { id: "d1" }, error: null }) }),
          }),
          update: () => ({ eq: async () => ({}) }),
        };
      },
    } as never;
    const result = await emitEvent(admin, {
      workspaceId: "ws-1",
      workspaceSlug: "acme",
      type: "node.created",
      data: {},
    });
    expect(result.enqueued).toBe(2);
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });
});
