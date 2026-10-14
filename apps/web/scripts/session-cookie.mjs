/**
 * Prints a Cookie header for a signed-in test user on the local stack, so a
 * server-rendered page can be fetched with curl as that person:
 *
 *   set -a; . ./.env.development.local; set +a
 *   COOKIE=$(node scripts/session-cookie.mjs ana@example.com)
 *   curl -s -H "cookie: $COOKIE" http://localhost:3000/workspaces | head -c 400
 *
 * Creates the user (confirmed, fixed password) if it does not exist. Local
 * Supabase only; refuses a `supabase.co` URL (the guard does not know the
 * self-hosted domain — point it at the Docker stack, never at production).
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL, ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !ANON || !SERVICE) throw new Error("load .env.development.local first");
if (URL_.includes("supabase.co")) throw new Error("refusing to run against a hosted project");
const email = process.argv[2] ?? "dev@example.com", password = "correct-horse-battery-staple";
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (!list.users.some((u) => u.email === email)) await admin.auth.admin.createUser({ email, password, email_confirm: true });
const jar = new Map();
const ssr = createServerClient(URL_, ANON, { cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (cs) => cs.forEach((c) => jar.set(c.name, c.value)) } });
const { error } = await ssr.auth.signInWithPassword({ email, password });
if (error) throw error;
process.stdout.write([...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "));
