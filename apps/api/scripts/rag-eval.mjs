/**
 * Score retrieval against a set of canonical questions, so a change to
 * chunking, rerank or the keyword scorer is measured instead of felt.
 *
 *   BCONTEXT_MCP_TOKEN=bctx_live_… npm run rag:eval -- --dataset my-eval.json --mode both --k 10
 *   npm run rag:eval -- --dataset my-eval.json --workspace acme/lab
 *   BCONTEXT_API_URL=http://localhost:4000 npm run rag:eval -- --dataset my-eval.json   # local stack
 *
 * Reads a dataset (below), asks `POST /api/agents/context` each question with
 * the token, and reports where the expected node landed: hit@1, hit@3 and MRR
 * over the ranked distinct nodes (graph-expansion neighbours are not ranked —
 * they ride along beyond `k` and are marked `expanded`). Two modes, one per
 * retrieval path: `embeddings` is what the product does (`retrieval: "auto"`),
 * `keyword` forces the scorer the product falls back to (`retrieval:
 * "keyword"`, see `RetrieveOptions.forceKeyword` and `RAG_FORCE_KEYWORD`).
 * The response's `scope.keyword_fallback` says which path actually answered;
 * a mode the server did not honour is reported, not scored.
 *
 * Dataset — a JSON file you keep next to your workspace:
 *
 *   {
 *     "workspace": "org/workspace",           // or null: pass --workspace
 *     "questions": [
 *       { "id": "short-name",
 *         "question": "why did we choose webhooks?",
 *         "expect": { "node_id": "uuid-or-prefix" }     // or { "title": "regex" }
 *                  // optional: "block_id": "decision" — the H2 that answers
 *         "note": "free text" }
 *     ]
 *   }
 *
 * Read-only: the endpoint retrieves and never writes. Against production it
 * needs a token with `agents:read` on the workspace; against the local stack
 * (`docs/ops/local-stack.md`) the same script with `BCONTEXT_API_URL`.
 *
 * Options: --dataset <path> (required),
 * --workspace <org/ws>, --mode embeddings|keyword|both (default both),
 * --k <n> (default 10, max 20), --only <question id>, --json,
 * --fail-under <mrr> (exit 1 when a scored mode's MRR is below it).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const API = (process.env.BCONTEXT_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const TOKEN = process.env.BCONTEXT_MCP_TOKEN;
if (!TOKEN) fail("BCONTEXT_MCP_TOKEN is required (an agent token with agents:read on the workspace)");

if (!args.dataset) fail("--dataset <path> is required");
const datasetPath = resolve(args.dataset);
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const workspace = args.workspace ?? dataset.workspace;
if (!workspace) fail(`dataset ${datasetPath} names no workspace; pass --workspace org/ws`);
const k = Math.min(20, Math.max(1, Number(args.k ?? 10)));
const modes = args.mode === "both" || !args.mode ? ["embeddings", "keyword"] : [args.mode];
if (modes.some((m) => m !== "embeddings" && m !== "keyword")) fail(`--mode must be embeddings, keyword or both`);
const questions = (dataset.questions ?? []).filter((q) => !args.only || q.id === args.only);
if (questions.length === 0) fail("no questions to run");

const report = { workspace, api: API, k, at: new Date().toISOString(), dataset: datasetPath, modes: {} };
let failed = false;

for (const mode of modes) {
  const rows = [];
  for (const q of questions) rows.push(await ask(q, mode));
  const honoured = rows.filter((r) => r.path === mode);
  const scored = honoured.length === rows.length;
  const summary = scored ? score(rows) : null;
  report.modes[mode] = { scored, path_seen: [...new Set(rows.map((r) => r.path))], summary, questions: rows };
  if (!args.json) printMode(mode, rows, summary, scored);
  if (scored && args["fail-under"] !== undefined && summary.mrr < Number(args["fail-under"])) failed = true;
}
if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(failed ? 1 : 0);

/* ── one question ─────────────────────────────────────────────────── */

async function ask(q, mode) {
  const res = await fetch(`${API}/api/agents/context`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      workspace,
      query: q.question,
      k,
      include_counts: false,
      fields: ["id"],
      retrieval: mode === "keyword" ? "keyword" : "auto",
    }),
  });
  if (!res.ok) fail(`${res.status} from ${API}/api/agents/context for "${q.id}": ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const path = body.scope?.keyword_fallback ? "keyword" : "embeddings";
  // Ranked distinct nodes, in the order the retriever returned them.
  const ranked = [];
  const seen = new Set();
  for (const h of body.retrieved ?? []) {
    if (h.expanded) continue;
    if (seen.has(h.node_id)) continue;
    seen.add(h.node_id);
    ranked.push(h);
  }
  const rankIdx = ranked.findIndex((h) => matches(h, q.expect));
  const rank = rankIdx === -1 ? null : rankIdx + 1;
  let blockRank = null;
  if (q.expect?.block_id) {
    const blocks = (body.retrieved ?? []).filter((h) => !h.expanded && matches(h, q.expect));
    const i = blocks.findIndex((h) => h.block_id === q.expect.block_id);
    blockRank = i === -1 ? null : i + 1;
  }
  return {
    id: q.id,
    question: q.question,
    expected: q.expect?.node_id ? q.expect.node_id.slice(0, 8) : `/${q.expect?.title}/`,
    path,
    rank,
    block_rank: blockRank,
    top: ranked.slice(0, 3).map((h) => ({ node_id: h.node_id.slice(0, 8), kind: h.kind, title: h.title })),
  };
}

function matches(hit, expect) {
  if (!expect) return false;
  if (expect.node_id) return hit.node_id === expect.node_id || hit.node_id.startsWith(expect.node_id);
  if (expect.title) return new RegExp(expect.title, "i").test(hit.title ?? "");
  return false;
}

/* ── scoring ──────────────────────────────────────────────────────── */

function score(rows) {
  const n = rows.length;
  const hit1 = rows.filter((r) => r.rank === 1).length;
  const hit3 = rows.filter((r) => r.rank !== null && r.rank <= 3).length;
  const mrr = rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n;
  // Only the questions that name a block take part in block@3.
  const blockRows = rows.filter((r) => expectedBlock(r.id));
  const block3 = blockRows.filter((r) => r.block_rank !== null && r.block_rank <= 3).length;
  return {
    n,
    hit_at_1: round(hit1 / n),
    hit_at_3: round(hit3 / n),
    mrr: round(mrr),
    ...(blockRows.length > 0 ? { block_at_3: round(block3 / blockRows.length), block_n: blockRows.length } : {}),
    hits: { at_1: hit1, at_3: hit3 },
  };
}

function expectedBlock(id) {
  return questions.find((q) => q.id === id)?.expect?.block_id ?? null;
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}

/* ── output ───────────────────────────────────────────────────────── */

function printMode(mode, rows, summary, scored) {
  const out = [];
  out.push(`\n## rag-eval · ${workspace} · ${mode} · k=${k} · ${report.at.slice(0, 10)}`);
  if (!scored) {
    out.push(`\n> not scored: asked for the ${mode} path but the server answered with ${rows.map((r) => r.path).filter((p, i, a) => a.indexOf(p) === i).join(", ")}` +
      (mode === "keyword" ? " — \`retrieval: \"keyword\"\` needs a deployment that carries it, or the local stack." : " — the workspace has no embeddings or no AI key; the product itself is on the keyword scorer here."));
  }
  out.push("");
  out.push("| # | question | expected | rank | block | top 3 |");
  out.push("|---|---|---|---|---|---|");
  rows.forEach((r, i) => {
    const top = r.top.map((t) => `${t.node_id} ${cell(t.title, 48)}`).join(" · ");
    const block = r.block_rank !== null ? String(r.block_rank) : expectedBlock(r.id) ? "—" : "";
    out.push(`| ${i + 1} | ${cell(r.question, 70)} | ${r.expected} | ${r.rank ?? "—"} | ${block} | ${top} |`);
  });
  if (summary) {
    out.push("");
    out.push(`**hit@1 ${summary.hits.at_1}/${summary.n} (${summary.hit_at_1}) · hit@3 ${summary.hits.at_3}/${summary.n} (${summary.hit_at_3}) · MRR ${summary.mrr}` +
      (summary.block_n ? ` · block@3 ${summary.block_at_3} (${summary.block_n} q)` : "") + "**");
  }
  console.log(out.join("\n"));
}

function cell(s, max) {
  const t = String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/* ── plumbing ─────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === "json") out.json = true;
    else if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function fail(msg) {
  console.error(`rag-eval: ${msg}`);
  process.exit(2);
}
