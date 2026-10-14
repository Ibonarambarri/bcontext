/**
 * Transaction semantics for the queue runtime.
 *
 * The point of these tests is the acceptance criterion "a job enqueued in an
 * aborted transaction never runs": if the enqueue rides the caller's
 * transaction, a rollback must take the job row with it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const queries: string[] = [];
const released: boolean[] = [];
let failOn: string | null = null;

const client = {
  query: vi.fn(async (text: string) => {
    queries.push(text.trim().split("\n")[0]!.trim());
    if (failOn && text.includes(failOn)) throw new Error("boom");
    return { rows: [{ id: "job-1" }] };
  }),
  release: vi.fn(() => released.push(true)),
};

vi.mock("pg", () => ({
  Pool: class {
    connect = async () => client;
    end = async () => {};
  },
}));

import { setPoolForTests, withTransaction, hasDatabaseUrl } from "./db";
import { Pool } from "pg";

beforeEach(() => {
  queries.length = 0;
  released.length = 0;
  failOn = null;
  client.query.mockClear();
  setPoolForTests(new Pool() as never);
});

describe("hasDatabaseUrl", () => {
  it("reflects the env var", () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    expect(hasDatabaseUrl()).toBe(false);
    process.env.DATABASE_URL = "postgres://x/y";
    expect(hasDatabaseUrl()).toBe(true);
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  });
});

describe("withTransaction", () => {
  it("wraps the callback in BEGIN/COMMIT and releases the client", async () => {
    const out = await withTransaction(async (tx) => {
      await tx.executeSql("insert into webhook_deliveries default values");
      return "ok";
    });
    expect(out).toBe("ok");
    expect(queries[0]).toBe("BEGIN");
    expect(queries.at(-1)).toBe("COMMIT");
    expect(released).toHaveLength(1);
  });

  it("rolls back and rethrows when the callback throws", async () => {
    await expect(
      withTransaction(async (tx) => {
        await tx.executeSql("insert into webhook_deliveries default values");
        throw new Error("domain failure");
      }),
    ).rejects.toThrow("domain failure");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(released).toHaveLength(1);
  });

  it("rolls back the row write when the enqueue inside the tx fails", async () => {
    // Stand-in for `boss.send(..., { db: tx })` blowing up: the delivery
    // insert already ran, and it must not survive.
    await expect(
      withTransaction(async (tx) => {
        await tx.executeSql("insert into webhook_deliveries default values");
        await tx.executeSql("insert into pgboss.job default values");
        throw new Error("enqueue failed");
      }),
    ).rejects.toThrow("enqueue failed");
    expect(queries).toContain("insert into webhook_deliveries default values");
    expect(queries).toContain("insert into pgboss.job default values");
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });

  it("still releases the client when ROLLBACK itself fails", async () => {
    failOn = "ROLLBACK";
    await expect(
      withTransaction(async () => {
        throw new Error("first failure");
      }),
    ).rejects.toThrow("first failure");
    expect(released).toHaveLength(1);
  });

  it("hands the callback an executor that returns pg rows", async () => {
    const rows = await withTransaction(async (tx) =>
      (await tx.executeSql("select 1")).rows,
    );
    expect(rows).toEqual([{ id: "job-1" }]);
  });
});
