"use client";

/**
 * Async accessor for the browser Supabase client.
 *
 * `@supabase/ssr` + `@supabase/supabase-js` cost ~55 KB gzip. Every consumer
 * that lives in the workspace shell's synchronous client tree (workspace
 * context, realtime presence, user menu) only ever touches Supabase inside
 * effects or event handlers — never during first paint — so they must use
 * this lazy accessor instead of importing `@/lib/supabase/browser` statically.
 * That keeps the SDK out of the shell's first-load chunk group; the module is
 * fetched once on demand and memoized by the module cache afterwards.
 */
export async function getSupabaseBrowserLazy() {
  const { getSupabaseBrowser } = await import("./browser");
  return getSupabaseBrowser();
}
