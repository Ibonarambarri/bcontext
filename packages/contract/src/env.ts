/**
 * Centralized env loading & validation.
 *
 * All optional, but typed and parsed once at boot via `instrumentation.ts`.
 * Other modules import `env` from here instead of reading `process.env`
 * directly so that a typo or missing key is surfaced as a single grouped
 * warning at startup rather than as a runtime undefined.
 */
import { z } from "zod";

const Schema = z.object({
  // Supabase gateway + anon key. The plain names are the ones to set; the
  // `NEXT_PUBLIC_*` spelling is the monolith's legacy and is read as a
  // fallback until 2026-12-31 (same rule as `src/lib/env.ts` in the API).
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  CHAT_MODEL: z.string().min(1).optional(),
  EMBED_MODEL: z.string().min(1).optional(),
  // Better Stack log/error telemetry. When both token and URL are set,
  // warn/error log lines are shipped to the Better Stack HTTP ingestion API
  // (see `better-stack.ts`). MIN_LEVEL overrides the warn floor.
  BETTER_STACK_SOURCE_TOKEN: z.string().min(1).optional(),
  BETTER_STACK_INGESTING_URL: z.string().min(1).optional(),
  BETTER_STACK_MIN_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  // The API process and its realtime server, as seen from the web. See
  // .env.example.
  API_ORIGIN: z.string().url().optional(),
  NEXT_PUBLIC_REALTIME_URL: z.string().url().optional(),
  REALTIME_SECRET: z.string().min(1).optional(),
});

export type Env = z.infer<typeof Schema>;

function read(): Env {
  const parsed = Schema.safeParse(process.env);
  if (parsed.success) return parsed.data;
  // On invalid shape, fall back to a permissive read so the app still boots.
  // The grouped warning is logged by `logEnvStatus()` below.
  return {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
    CHAT_MODEL: process.env.CHAT_MODEL,
    EMBED_MODEL: process.env.EMBED_MODEL,
    BETTER_STACK_SOURCE_TOKEN: process.env.BETTER_STACK_SOURCE_TOKEN,
    BETTER_STACK_INGESTING_URL: process.env.BETTER_STACK_INGESTING_URL,
    BETTER_STACK_MIN_LEVEL: process.env.BETTER_STACK_MIN_LEVEL as
      | Env["BETTER_STACK_MIN_LEVEL"]
      | undefined,
    API_ORIGIN: process.env.API_ORIGIN,
    NEXT_PUBLIC_REALTIME_URL: process.env.NEXT_PUBLIC_REALTIME_URL,
    REALTIME_SECRET: process.env.REALTIME_SECRET,
  };
}

export const env: Env = read();

/**
 * The Supabase gateway URL, plain name first and the legacy `NEXT_PUBLIC_`
 * spelling as fallback — the same precedence as `supabaseUrl()` in the API's
 * `src/lib/env.ts`, kept in sync by hand because the contract cannot import
 * from `src/`. Read at call time, not from the boot snapshot, so a process
 * that sets the variable late (or a test that sets it per case) sees it.
 */
export function supabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
}

/** The anon JWT, with the same plain-first precedence as `supabaseUrl()`. */
export function supabaseAnonKey(): string | undefined {
  return process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}

/**
 * Supabase is configured when the gateway URL and the anon key are both
 * present under either spelling. Callers use this to decide between the real
 * database and the in-memory demo store.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl() && supabaseAnonKey());
}

/**
 * Print a single grouped diagnostic at startup. Called from `instrumentation.ts`.
 * Never throws — env vars are all optional, this is purely advisory.
 */
export function logEnvStatus(): void {
  const parsed = Schema.safeParse(process.env);
  const invalid = parsed.success ? [] : parsed.error.issues.map((i) => i.path.join(".") || "(root)");
  const missing: string[] = [];
  if (!supabaseUrl()) missing.push("SUPABASE_URL");
  if (!supabaseAnonKey()) missing.push("SUPABASE_ANON_KEY");
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!env.AI_GATEWAY_API_KEY) missing.push("AI_GATEWAY_API_KEY");

  if (missing.length === 0 && invalid.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[env] all known vars present");
    return;
  }
  // eslint-disable-next-line no-console
  console.group("[env] startup notice");
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `missing (running in degraded mode where applicable): ${missing.join(", ")}`,
    );
  }
  if (invalid.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`invalid: ${invalid.join(", ")}`);
  }
  // eslint-disable-next-line no-console
  console.groupEnd();
}
