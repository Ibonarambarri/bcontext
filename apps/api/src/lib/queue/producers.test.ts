/**
 * Enqueue semantics — in particular the difference between the transactional
 * and best-effort paths, which is the whole reason this module exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn(async () => "job-1");
vi.mock("./boss", () => ({ getBoss: async () => ({ send }) }));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { enqueue } from "./producers";

const prev = process.env.DATABASE_URL;

beforeEach(() => {
  send.mockClear();
  send.mockResolvedValue("job-1");
  process.env.DATABASE_URL = "postgres://user@host/db";
});
afterEach(() => {
  if (prev === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prev;
});

describe("enqueue", () => {
  it("is a no-op when the queue runtime is not configured", async () => {
    delete process.env.DATABASE_URL;
    await expect(enqueue("webhook.drain")).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends through the caller's transaction when one is supplied", async () => {
    const tx = { executeSql: vi.fn(async () => ({ rows: [] })) };
    await enqueue("webhook.drain", { reason: "emit" }, { tx, singletonKey: "emit" });
    expect(send).toHaveBeenCalledWith(
      "webhook.drain",
      { reason: "emit" },
      { singletonKey: "emit", db: tx },
    );
  });

  it("propagates a failed transactional enqueue so the caller rolls back", async () => {
    send.mockRejectedValueOnce(new Error("job insert failed"));
    const tx = { executeSql: vi.fn(async () => ({ rows: [] })) };
    await expect(enqueue("webhook.drain", {}, { tx })).rejects.toThrow(
      "job insert failed",
    );
  });

  it("swallows a failed best-effort enqueue outside a transaction", async () => {
    send.mockRejectedValueOnce(new Error("db unreachable"));
    await expect(enqueue("webhook.drain")).resolves.toBeNull();
  });

  it("does not pass a db option when there is no transaction", async () => {
    await enqueue("connector.drain", { a: 1 });
    expect(send).toHaveBeenCalledWith("connector.drain", { a: 1 }, {});
  });
});
