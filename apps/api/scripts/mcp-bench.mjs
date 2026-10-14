/**
 * Latency of an authenticated MCP `initialize`, the request every agent turn
 * begins with, against whatever serves BASE.
 *
 *   BASE=http://localhost:3000 node scripts/mcp-bench.mjs   # bcontext-web → API proxy
 *   BASE=http://localhost:4000 node scripts/mcp-bench.mjs   # the API process directly
 *
 * Needs .env.development.local (local Supabase stack, docs/ops/local-stack.md)
 * loaded into the environment — it refuses a hosted project. Reads the
 * `NEXT_PUBLIC_SUPABASE_*` names; those are legacy aliases of `SUPABASE_URL`
 * / `SUPABASE_ANON_KEY` kept until 2026-12-31 and what local-env.sh writes.
 *
 * Gets a real token through the OAuth flow first (same steps as oauth-e2e),
 * then N sequential requests. Sequential on purpose: the question is per-
 * request cost, not throughput. Reports p50/p95/p99 and who served it.
 * Production builds only — a Next dev server on :3000 measures Turbopack,
 * not the app.
 *
 * With LOAD_URL set, LOAD_C concurrent loops hammer that page for the whole
 * run. That is the isolation question behind splitting the API out of the
 * web process: does rendering the UI slow down an agent's MCP call when both
 * share one Node event loop, and does it stop when the API is its own process?
 *
 *   LOAD_URL=http://localhost:3000/ LOAD_C=16 BASE=http://localhost:3000 node scripts/mcp-bench.mjs
 */
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.env.BASE ?? "http://localhost:3000").replace(/\/$/, "");
const N = Number(process.env.N ?? 200);
const LOAD_URL = process.env.LOAD_URL;
const LOAD_C = Number(process.env.LOAD_C ?? 16);
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL, ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !ANON || !SERVICE) throw new Error("load .env.development.local first");
if (URL_.includes("supabase.co")) throw new Error("refusing to run against a hosted project");
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// token
const email = `bench-${Date.now()}@example.com`, password = "correct-horse-battery-staple";
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
await admin.auth.admin.createUser({ email, password, email_confirm: true });
const jar = new Map();
const ssr = createServerClient(URL_, ANON, { cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (cs) => cs.forEach((c) => jar.set(c.name, c.value)) } });
await ssr.auth.signInWithPassword({ email, password });
const browser = { cookie: [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "), origin: BASE, host: new URL(BASE).host };
let res = await fetch(`${BASE}/api/workspaces`, { method: "POST", headers: { ...browser, "content-type": "application/json" }, body: JSON.stringify({ name: `Bench ${Date.now()}` }) });
const ws = await res.json(); const wsSlug = ws.workspace?.slug ?? ws.slug; const workspaceId = ws.workspace?.id ?? ws.id;
const redirectUri = "http://127.0.0.1:9999/callback";
res = await fetch(`${BASE}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "bench", redirect_uris: [redirectUri], scope: "nodes:read" }) });
const client = await res.json();
const verifier = b64url(randomBytes(32)), challenge = b64url(createHash("sha256").update(verifier).digest());
const form = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, scope: "nodes:read", state: "s", code_challenge: challenge, code_challenge_method: "S256", agent_name: "bench", provider: "claude_code", role: "observer", decision: "allow" });
form.append("workspace_ids", workspaceId); form.append("scopes", "nodes:read");
res = await fetch(`${BASE}/api/oauth/authorize`, { method: "POST", headers: { ...browser, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
const code = new URL(res.headers.get("location")).searchParams.get("code");
if (!code) throw new Error(`authorize failed: ${res.headers.get("location")}`);
res = await fetch(`${BASE}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, client_secret: client.client_secret, code_verifier: verifier }) });
const { access_token } = await res.json();
if (!access_token) throw new Error("no token");

// bench
const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bench", version: "1" } } });
const headers = { authorization: `Bearer ${access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-bcontext-workspace": wsSlug };
const one = async () => { const t = performance.now(); const r = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: init }); await r.text(); if (r.status !== 200) throw new Error(`status ${r.status}`); return [performance.now() - t, r.headers.get("x-served-by") ?? "next"]; };
for (let i = 0; i < 20; i++) await one(); // warm-up

// Background load: page renders, as many in flight as LOAD_C, until told to stop.
let loadDone = 0, loadErr = 0, stop = false;
const loaders = LOAD_URL
  ? Array.from({ length: LOAD_C }, async () => {
      while (!stop) {
        try { const r = await fetch(LOAD_URL, { headers: { accept: "text/html" } }); await r.text(); r.ok ? loadDone++ : loadErr++; }
        catch { loadErr++; }
      }
    })
  : [];
if (LOAD_URL) { await new Promise((r) => setTimeout(r, 1500)); } // let the load ramp before measuring

const times = []; let served = "";
for (let i = 0; i < N; i++) { const [ms, by] = await one(); times.push(ms); served = by; }
stop = true; await Promise.all(loaders);
times.sort((a, b) => a - b);
const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(1);
const load = LOAD_URL ? `  load=${LOAD_C}x ${new URL(LOAD_URL).pathname} (${loadDone} renders, ${loadErr} errors)` : "";
console.log(`${BASE}  served-by=${served}  n=${N}  p50=${q(0.5)}ms  p95=${q(0.95)}ms  p99=${q(0.99)}ms  mean=${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)}ms${load}`);
