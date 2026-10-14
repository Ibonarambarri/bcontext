/**
 * Direct Postgres access for the job runtime.
 *
 * The rest of the product talks to Postgres through PostgREST
 * (`@supabase/supabase-js`), which cannot express a multi-statement
 * transaction. pg-boss needs a real connection anyway, so this module owns
 * the one `pg.Pool` in the codebase and exposes it in the shape pg-boss
 * wants (`IDatabase.executeSql`).
 *
 * The reason it matters beyond pg-boss: `withTransaction` hands the caller
 * an `IDatabase` bound to a single client inside `BEGIN`/`COMMIT`. Passing
 * that object to `boss.send(name, data, { db: tx })` writes the job row in
 * the same transaction as the caller's own writes — so a job can never be
 * queued for a write that rolled back, and a committed write can never lose
 * its job because the process died in between.
 *
 * This module is part of the worker bundle: keep it free of request-only
 * dependencies (`build:worker` checks the import graph).
 */
import { Pool, type PoolClient } from "pg";
import { sslFor } from "./ssl";

/** Minimal shape pg-boss consumes; kept structural so tests can fake it. */
export interface Executor {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

let pool: Pool | null = null;

/** True when a direct connection string is configured. */
export function hasDatabaseUrl(): boolean {
  return Boolean(databaseUrl());
}

export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || undefined;
}

/**
 * Lazily-built shared pool. Small on purpose: the worker is one process and
 * Supabase's pooler charges per connection.
 */
export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    application_name: process.env.DATABASE_APP_NAME ?? "bcontext-worker",
    ssl: sslFor(connectionString),
  });
  // An idle client whose session dies emits `error` on the pool, and an
  // `error` nobody listens to is an uncaught exception — the API would exit
  // because a pooler restarted. The pool discards the client on its own.
  pool.on("error", (err) => {
    console.warn("[db] idle client error:", err.message);
  });
  return pool;
}

/** Test seam — lets a test install a fake pool (or reset between suites). */
export function setPoolForTests(next: Pool | null): void {
  pool = next;
}

export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}

function executorFor(client: PoolClient): Executor {
  return {
    async executeSql(text: string, values: unknown[] = []) {
      const res = await client.query(text, values as never[]);
      return { rows: res.rows as unknown[] };
    },
  };
}

/**
 * Run `fn` inside a single transaction. The `Executor` it receives is both a
 * query runner and the object to hand to `boss.send(..., { db: tx })`.
 *
 * Rolls back and rethrows on any error — including an error thrown by the
 * enqueue itself, so "row written but job lost" is not reachable.
 */
export async function withTransaction<T>(
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(executorFor(client));
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection already broken; the server rolls back on its own.
    }
    throw err;
  } finally {
    client.release();
  }
}
