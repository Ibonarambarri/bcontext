import { afterEach, describe, expect, it } from "vitest";
import { sslFor } from "./ssl";

describe("sslFor", () => {
  afterEach(() => { delete process.env.DATABASE_SSL; });

  it.each([
    "postgresql://postgres:postgres@localhost:5432/postgres",
    // What `supabase status` actually prints — the case both copies missed.
    "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
    "postgresql://postgres:postgres@[::1]:5432/postgres",
  ])("plain TCP for loopback: %s", (url) => {
    expect(sslFor(url)).toBeUndefined();
  });

  it("TLS for anything that is not loopback", () => {
    expect(
      sslFor("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"),
    ).toEqual({ rejectUnauthorized: false });
  });

  it("does not mistake a database named localhost for a loopback host", () => {
    expect(sslFor("postgresql://u:p@db.example.com:5432/localhost")).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("honours an explicit override in both directions", () => {
    process.env.DATABASE_SSL = "disable";
    expect(sslFor("postgresql://u:p@db.example.com/x")).toBeUndefined();
    process.env.DATABASE_SSL = "require";
    expect(sslFor("postgresql://u:p@localhost/x")).toEqual({ rejectUnauthorized: false });
  });
});
