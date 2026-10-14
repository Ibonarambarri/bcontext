/**
 * The realtime server against a running API process and the local stack.
 *
 *   set -a; . ./.env.development.local; set +a
 *   API=http://localhost:4000 node scripts/realtime-smoke.mjs
 *
 * Two real people (local Supabase Auth), one workspace they both belong to,
 * one node. Then: presence between them, an event fanned out, a Yjs frame
 * relayed, a broadcast handed in over HTTP by "another process", and a
 * stranger refused at the handshake. Every step asserts.
 *
 * Needs the local stack (docs/ops/local-stack.md) and an API process built
 * with `npm run build:api`; refuses a hosted project. Reads the
 * `NEXT_PUBLIC_SUPABASE_*` names — legacy aliases of `SUPABASE_URL` /
 * `SUPABASE_ANON_KEY` kept until 2026-12-31, and what local-env.sh writes.
 * `REALTIME_SECRET` is the internal secret
 * `POST /realtime/broadcast` checks.
 */
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const API = (process.env.API ?? "http://localhost:4000").replace(/\/$/, "");
const WS = API.replace(/^http/, "ws");
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL, ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.REALTIME_SECRET;
if (!URL_ || !ANON || !SERVICE || !SECRET) throw new Error("load .env.development.local first");
if (URL_.includes("supabase.co")) throw new Error("refusing to run against a hosted project");

const step = (n) => console.log(`\n▶ ${n}`);
function assert(c, m) { if (!c) { console.error(`  ✗ ${m}`); process.exit(1); } console.log(`  ✓ ${m}`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function person(label) {
  const email = `rt-${label}-${Date.now()}@example.com`, password = "correct-horse-battery-staple";
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const jar = new Map();
  const ssr = createServerClient(URL_, ANON, { cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (cs) => cs.forEach((c) => jar.set(c.name, c.value)) } });
  const { data } = await ssr.auth.signInWithPassword({ email, password });
  const cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  return { label, jwt: data.session.access_token, userId: data.user.id, headers: { cookie, origin: API, host: new URL(API).host, "content-type": "application/json" } };
}
function connect(path, jwt) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}${path}?token=${encodeURIComponent(jwt)}`);
    ws.frames = [];
    ws.on("message", (d) => ws.frames.push(JSON.parse(d.toString())));
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_r, res) => reject(new Error(`http ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

step("two people, one workspace, one node");
const ana = await person("ana"), bo = await person("bo"), eve = await person("eve");
let res = await fetch(`${API}/api/workspaces`, { method: "POST", headers: ana.headers, body: JSON.stringify({ name: `Realtime ${Date.now()}` }) });
const ws = await res.json(); const workspaceId = ws.workspace?.id ?? ws.id; const slug = ws.workspace?.slug ?? ws.slug;
assert(res.status === 201 && workspaceId, `Ana created workspace ${slug}`);
// Bo joins through the real path: Ana invites, Bo accepts. That writes membership + grant.
res = await fetch(`${API}/api/workspaces/${slug}/members`, { headers: ana.headers });
// (no invite API over REST; use the DB directly for membership — the grant mirror handles the rest)
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
await admin.from("memberships").insert({ user_id: bo.userId, workspace_id: workspaceId, role: "editor" });
await admin.from("workspace_grants").insert({ workspace_id: workspaceId, principal_kind: "user", principal_id: bo.userId, verbs: ["read", "write"], reach: { type: "all" } });
res = await fetch(`${API}/api/nodes`, { method: "POST", headers: ana.headers, body: JSON.stringify({ workspace: slug, kind: "doc", title: "Shared doc", content_md: "# Shared", parent_id: null }) });
const created = await res.json();
const nodeId = created.node?.id;
if (!nodeId) console.error(`  POST /api/nodes → ${res.status} ${JSON.stringify(created).slice(0, 200)}`);
assert(res.status === 201 && nodeId, `node ${nodeId}`);

step("handshake");
await connect(`/realtime/ws/${workspaceId}`, eve.jwt).then(() => assert(false, "stranger refused")).catch((e) => assert(/http 404/.test(e.message), `stranger (no grant) refused as 404: ${e.message}`));
await connect(`/realtime/ws/${workspaceId}`, "garbage").then(() => assert(false, "bad token refused")).catch((e) => assert(/http 401/.test(e.message), `bad token refused as 401`));

step("presence between people");
const a = await connect(`/realtime/ws/${workspaceId}`, ana.jwt);
a.send(JSON.stringify({ t: "presence", state: { key: "ana-tab", userId: ana.userId, name: "Ana", color: "#f00", pageId: nodeId } }));
await wait(100);
const b = await connect(`/realtime/ws/${workspaceId}`, bo.jwt);
await wait(100);
const roster = b.frames.find((f) => f.t === "presence")?.peers ?? [];
assert(roster.some((p) => p.name === "Ana" && p.pageId === nodeId), `Bo joins and sees Ana on the doc`);
b.send(JSON.stringify({ t: "presence", state: { key: "bo-tab", userId: bo.userId, name: "Bo", color: "#0f0", pageId: null } }));
await wait(100);
assert((a.frames.at(-1)?.peers ?? []).some((p) => p.name === "Bo"), "Ana sees Bo arrive");

step("events");
a.send(JSON.stringify({ t: "event", event: { kind: "node.updated", payload: { nodeId } } }));
await wait(100);
assert(b.frames.some((f) => f.t === "event" && f.event.kind === "node.updated"), "Ana's event reaches Bo");
res = await fetch(`${API}/realtime/broadcast`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ workspaceId, event: { kind: "tree.invalidated", payload: {}, from: "worker" } }) });
await wait(100);
assert(res.status === 200 && b.frames.some((f) => f.t === "event" && f.event.kind === "tree.invalidated") && a.frames.some((f) => f.t === "event" && f.event.kind === "tree.invalidated"), "a broadcast from another process reaches both");
res = await fetch(`${API}/realtime/broadcast`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
assert(res.status === 401, "broadcast without the secret → 401");

step("collab relay");
const ca = await connect(`/realtime/collab/${nodeId}`, ana.jwt);
const cb = await connect(`/realtime/collab/${nodeId}`, bo.jwt);
ca.send(JSON.stringify({ type: "update", clientId: 1, update: "AQID" }));
await wait(100);
assert(cb.frames.some((f) => f.type === "update" && f.update === "AQID"), "Ana's Yjs update reaches Bo, verbatim");
await connect(`/realtime/collab/${nodeId}`, eve.jwt).then(() => assert(false, "stranger refused")).catch((e) => assert(/http 404/.test(e.message), "stranger refused at the document too"));

step("stats + leave");
res = await fetch(`${API}/realtime/stats`, { headers: { authorization: `Bearer ${SECRET}` } });
const stats = await res.json();
assert(stats.workspaces === 1 && stats.nodeRooms === 1 && stats.connections === 4, `stats ${JSON.stringify(stats)}`);
b.close(); await wait(100);
assert(!(a.frames.at(-1)?.peers ?? []).some((p) => p.name === "Bo"), "Bo leaves and Ana's roster drops him");
for (const s of [a, ca, cb]) s.close();
console.log(`\nrealtime OK against ${API}`);
