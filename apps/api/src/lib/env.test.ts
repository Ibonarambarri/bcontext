import { afterEach, describe, expect, it } from "vitest";
import { supabaseAuthCookieName, supabasePublicUrl, toPublicSupabaseUrl } from "./env";

const KEYS = ["SUPABASE_URL", "SUPABASE_PUBLIC_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function set(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

describe("public Supabase gateway", () => {
  it("falls back to SUPABASE_URL when no public URL is set", () => {
    set({ SUPABASE_URL: "https://supabase.example.com" });
    expect(supabasePublicUrl()).toBe("https://supabase.example.com");
    expect(toPublicSupabaseUrl("https://supabase.example.com/storage/v1/x")).toBe("https://supabase.example.com/storage/v1/x");
    expect(supabaseAuthCookieName()).toBe("sb-supabase-auth-token");
  });

  it("rewrites internal URLs onto the public origin and names the cookie after it", () => {
    set({ SUPABASE_URL: "http://kong:8000", SUPABASE_PUBLIC_URL: "https://ctx.example.com/" });
    expect(toPublicSupabaseUrl("http://kong:8000/storage/v1/object/sign/b/f?token=t")).toBe(
      "https://ctx.example.com/storage/v1/object/sign/b/f?token=t",
    );
    expect(toPublicSupabaseUrl("https://elsewhere.test/a")).toBe("https://elsewhere.test/a");
    expect(supabaseAuthCookieName()).toBe("sb-ctx-auth-token");
  });

  it("has no cookie name without a gateway", () => {
    set({});
    expect(supabaseAuthCookieName()).toBeUndefined();
  });
});
