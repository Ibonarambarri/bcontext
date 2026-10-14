/**
 * OAuth 2.1 end to end, against a running stack.
 *
 *   BASE=http://localhost:3000 node scripts/oauth-e2e.mjs     # through bcontext-web's proxy
 *   BASE=http://localhost:4000 node scripts/oauth-e2e.mjs     # the API process directly
 *
 * Needs .env.development.local (local Supabase stack, docs/ops/local-stack.md)
 * loaded into the environment; refuses a hosted project. Reads the
 * `NEXT_PUBLIC_SUPABASE_*` names — legacy aliases of `SUPABASE_URL` /
 * `SUPABASE_ANON_KEY` kept until 2026-12-31, and what local-env.sh writes.
 * Walks the surface an MCP client walks: dynamic client registration, the
 * consent POST with a real browser session cookie, code → token with PKCE,
 * the MCP handshake with the bearer, and revocation (the access token must
 * die). Started from the root endpoint (no `resource`), the consent flow
 * issues USER-scoped grants — no TTL, no refresh token, workspace chosen per
 * request via X-Bcontext-Workspace — so refresh rotation is not on this
 * path; it is covered for workspace-scoped grants (the ones a
 * `/mcp/<org>/<workspace>` resource yields) in src/lib/auth/oauth.test.ts.
 * Every step
 * asserts; the script exits non-zero on the first thing that is not as the
 * spec says. Run it against both BASEs and the flow-level parity is the diff.
 */
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.env.BASE ?? "http://localhost:3000").replace(/\/$/, "");
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !ANON || !SERVICE) throw new Error("load .env.development.local first");
if (URL_.includes("supabase.co")) throw new Error("refusing to run against a hosted project");

const step = (name) => console.log(`\n▶ ${name}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
function assert(cond, msg) { if (!cond) { console.error(`  ✗ ${msg}`); process.exit(1); } ok(msg); }
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// 1. A person, and a session cookie in exactly the shape the app reads.
step("user + session");
const email = `e2e-${Date.now()}@example.com`, password = "correct-horse-battery-staple";
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const { error: cErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
assert(!cErr, `created ${email}`);
const jar = new Map();
const ssr = createServerClient(URL_, ANON, {
  cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (cs) => cs.forEach((c) => jar.set(c.name, c.value)) },
});
const { error: sErr } = await ssr.auth.signInWithPassword({ email, password });
assert(!sErr && jar.size > 0, `signed in; ${jar.size} session cookie(s)`);
const cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
const browser = { cookie, origin: BASE, host: new URL(BASE).host };

// 2. A workspace the person belongs to (creates membership + grant through the real path).
step("workspace");
let res = await fetch(`${BASE}/api/workspaces`, { method: "POST", headers: { ...browser, "content-type": "application/json" }, body: JSON.stringify({ name: `E2E ${Date.now()}` }) });
assert(res.status === 201 || res.status === 200, `POST /api/workspaces → ${res.status}`);
const ws = await res.json();
const workspaceId = ws.workspace?.id ?? ws.id;
assert(workspaceId, `workspace ${workspaceId}`);

// 3. Dynamic client registration (RFC 7591).
step("register");
const redirectUri = "http://127.0.0.1:9999/callback";
res = await fetch(`${BASE}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "e2e client", redirect_uris: [redirectUri], scope: "nodes:read nodes:write" }) });
assert(res.status === 201, `POST /api/oauth/register → ${res.status}`);
const client = await res.json();
assert(client.client_id && client.client_secret, "client_id + client_secret issued");

// 4. Consent, as the browser posts it, with PKCE.
step("authorize");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const form = new URLSearchParams();
form.set("client_id", client.client_id); form.set("redirect_uri", redirectUri); form.set("scope", "nodes:read nodes:write");
form.set("state", "xyz"); form.set("code_challenge", challenge); form.set("code_challenge_method", "S256");
form.append("workspace_ids", workspaceId); form.append("scopes", "nodes:read"); form.append("scopes", "nodes:write");
form.set("agent_name", "e2e agent"); form.set("provider", "claude_code"); form.set("role", "collaborator"); form.set("decision", "allow");
res = await fetch(`${BASE}/api/oauth/authorize`, { method: "POST", headers: { ...browser, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
assert(res.status === 303, `POST /api/oauth/authorize → ${res.status} (expected 303)`);
const loc = new URL(res.headers.get("location"));
const code = loc.searchParams.get("code");
if (!code) console.error(`  location: ${loc.href}`);
assert(loc.origin + loc.pathname === redirectUri && code && loc.searchParams.get("state") === "xyz", `redirected to client with code + state`);

// 5. Code → tokens.
step("token (authorization_code)");
const tokenReq = (body) => fetch(`${BASE}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
res = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, client_secret: client.client_secret, code_verifier: verifier });
assert(res.status === 200, `POST /api/oauth/token → ${res.status}`);
const t1 = await res.json();
assert(t1.access_token && t1.token_type?.toLowerCase() === "bearer", "access token issued");
assert(t1.scope_kind === "user" && t1.workspace_id === null && t1.refresh_token === undefined && t1.expires_in === undefined,
  "user-scoped: no workspace, no refresh token, no expires_in (by design)");
res = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, client_secret: client.client_secret, code_verifier: verifier });
assert(res.status === 400, `code cannot be redeemed twice → ${res.status}`);

// 6. MCP with the bearer.
step("mcp");
const wsSlug = ws.workspace?.slug ?? ws.slug;
const mcp = (token, body, extra = {}) => fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-bcontext-workspace": wsSlug, ...extra }, body: JSON.stringify(body) });
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } };
res = await mcp(t1.access_token, init);
assert(res.status === 200, `POST /mcp initialize (workspace ${wsSlug}) → ${res.status}`);
res = await mcp(t1.access_token, init, { "x-bcontext-workspace": "" });
assert(res.status === 200 || res.status === 400, `without selector → ${res.status} (single workspace resolves alone; several demand a selector)`);
assert((res.headers.get("x-served-by") ?? "next") === (BASE.endsWith(":4000") ? "api" : (res.headers.get("x-served-by") ?? "next")), `served by ${res.headers.get("x-served-by") ?? "next"}`);
res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init) });
assert(res.status === 401 && /resource_metadata=/.test(res.headers.get("www-authenticate") ?? ""), "no bearer → 401 with resource_metadata hint");

// 7. Revoke; access dies.
step("revoke");
res = await fetch(`${BASE}/api/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t1.access_token, client_id: client.client_id, client_secret: client.client_secret }) });
assert(res.status === 200, `POST /api/oauth/revoke → ${res.status}`);
res = await mcp(t1.access_token, init);
assert(res.status === 401, `revoked access token → ${res.status} on /mcp`);
res = await fetch(`${BASE}/api/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: "not-a-token", client_id: client.client_id, client_secret: client.client_secret }) });
assert(res.status === 200, `unknown token → ${res.status} (RFC 7009: never a probe)`);

console.log(`\nOAuth 2.1 end to end OK against ${BASE}`);
