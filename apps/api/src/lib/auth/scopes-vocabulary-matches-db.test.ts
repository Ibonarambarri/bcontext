import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SCOPES } from "@bcontext-dev/contract/auth/scopes";
import {
  AGENT_PROVIDERS,
  AGENT_ROLES,
} from "@bcontext-dev/contract/agents/connections";

/**
 * The vocabularies that exist twice.
 *
 * `agent_workspace_access.scopes` is a `text[]` guarded by a CHECK that lists
 * every scope, and `agents.provider` and `agent_workspace_access.role` do the
 * same for theirs. Those lists are copies of arrays in the contract, and a
 * copy drifts: `credentials:use` was added to the contract with typed
 * credentials and never to the constraint, so `/api/onboarding/create` — which
 * mints a token holding every scope — started answering 500 and creating
 * nothing. Nothing failed at deploy time, because a CHECK is only evaluated on
 * write. The first person to hear about it was a customer who could not get in.
 *
 * This is that failure moved to where it is cheap: the migrations are read as
 * text, the newest definition of each constraint wins, and its literals must be
 * exactly what the contract declares. It cannot see production, so it does not
 * prove the database is right — it proves the repository is consistent with
 * itself, which is the half that was wrong.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

/**
 * The literals of the LAST definition of a constraint across the migrations,
 * in file order. Later migrations redefine what earlier ones created, so the
 * last one is the shape the database ends up with.
 */
function literalsOfLatest(constraintName: string): string[] | null {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let found: string[] | null = null;

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    // Every definition of this constraint in this file, `add constraint <name>
    // check (...)` or an inline `check (...)` in the create table that owns it.
    const pattern = new RegExp(
      `add constraint\\s+${constraintName}\\s+check\\s*\\(([\\s\\S]*?)\\);`,
      "gi",
    );
    for (const match of sql.matchAll(pattern)) {
      found = quoted(match[1] ?? "");
    }
  }
  return found;
}

/** Single-quoted strings, in the order they appear. */
function quoted(sql: string): string[] {
  return [...sql.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

/** The inline CHECK of a column inside its `create table`, for the ones that
 *  no later migration has redefined. */
function inlineCheck(file: string, column: string): string[] {
  const sql = readFileSync(join(MIGRATIONS, file), "utf8");
  const at = sql.indexOf(column);
  expect(at, `${column} not found in ${file}`).toBeGreaterThan(-1);
  const window = sql.slice(at, at + 400);
  const check = /check\s*\(([\s\S]*?)\)\s*\)/i.exec(window);
  return quoted(check?.[1] ?? "");
}

describe("the scope vocabulary the database enforces", () => {
  it("is exactly the one the contract declares", () => {
    const inDb = literalsOfLatest("agent_workspace_access_scopes_check");
    expect(inDb, "no migration defines the constraint").not.toBeNull();
    expect([...(inDb as string[])].sort()).toEqual([...SCOPES].sort());
  });

  it("has every scope, so a token holding all of them can be written", () => {
    // What onboarding does: `createToken(..., { scopes: [...SCOPES] })`. If one
    // scope is missing from the constraint, that write is refused and the first
    // workspace is never created.
    const inDb = new Set(literalsOfLatest("agent_workspace_access_scopes_check") ?? []);
    for (const scope of SCOPES) {
      expect(inDb.has(scope), `the constraint is missing ${scope}`).toBe(true);
    }
  });
});

describe("the other vocabularies copied into the schema", () => {
  it("agent roles match", () => {
    expect(
      inlineCheck("0032_agent_connections.sql", "role text not null check").sort(),
    ).toEqual([...AGENT_ROLES].sort());
  });

  it("agent providers match", () => {
    expect(
      inlineCheck("0032_agent_connections.sql", "provider text not null check").sort(),
    ).toEqual([...AGENT_PROVIDERS].sort());
  });
});
