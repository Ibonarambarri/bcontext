import { afterEach, describe, expect, it } from "vitest";
import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from "./env";

// The four spellings this helper resolves. Every case starts clean so a
// developer's shell (or another test) cannot leak a value into the assertion.
const NAMES = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));

function clear() {
  for (const n of NAMES) delete process.env[n];
}

afterEach(() => {
  clear();
  for (const n of NAMES) if (saved[n] !== undefined) process.env[n] = saved[n];
});

describe("isSupabaseConfigured", () => {
  it("is false when neither spelling is set", () => {
    clear();
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("accepts the plain names — the ones the runbook tells operators to set", () => {
    clear();
    process.env.SUPABASE_URL = "https://supabase.example.dev";
    process.env.SUPABASE_ANON_KEY = "anon";
    expect(isSupabaseConfigured()).toBe(true);
  });

  it("still accepts the legacy NEXT_PUBLIC_* spelling as a fallback", () => {
    clear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://legacy.example.dev";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    expect(isSupabaseConfigured()).toBe(true);
  });

  it("needs both the URL and the key, mixed spellings included", () => {
    clear();
    process.env.SUPABASE_URL = "https://supabase.example.dev";
    expect(isSupabaseConfigured()).toBe(false);
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    expect(isSupabaseConfigured()).toBe(true);
  });

  it("lets the plain name win over the legacy one, like src/lib/env.ts in the API", () => {
    clear();
    process.env.SUPABASE_URL = "https://plain.example.dev";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://legacy.example.dev";
    process.env.SUPABASE_ANON_KEY = "plain";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "legacy";
    expect(supabaseUrl()).toBe("https://plain.example.dev");
    expect(supabaseAnonKey()).toBe("plain");
  });

  it("reads at call time rather than from the boot snapshot", () => {
    clear();
    expect(isSupabaseConfigured()).toBe(false);
    process.env.SUPABASE_URL = "https://late.example.dev";
    process.env.SUPABASE_ANON_KEY = "anon";
    expect(isSupabaseConfigured()).toBe(true);
  });
});
