#!/usr/bin/env node
/**
 * Export one skill node as SKILL.md-shaped markdown.
 *
 * The inverse of `skills_write(op=import)`: reads the `skill` node whose
 * frontmatter `name` matches over REST and writes its body verbatim, so a
 * file that lives elsewhere (the plugin's SKILL.md, a catalogue) can be
 * regenerated from the node that is its single source.
 *
 * Usage:
 *   BCONTEXT_MCP_TOKEN=... node scripts/export-skill.mjs <org/workspace> <skill-name> <out-path>
 *
 * Env:
 *   BCONTEXT_MCP_TOKEN   agent token (required)
 *   BCONTEXT_API_URL     API origin (default http://localhost:4000)
 *
 * Self-contained: Node built-ins only. Exit 2 on usage errors, 1 on API errors.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const [workspaceRef, skillName, outPath] = process.argv.slice(2);
if (!workspaceRef || !skillName || !outPath || workspaceRef.startsWith("-")) {
  console.error("usage: export-skill.mjs <org/workspace> <skill-name> <out-path>");
  process.exit(2);
}
const token = process.env.BCONTEXT_MCP_TOKEN;
if (!token) {
  console.error("BCONTEXT_MCP_TOKEN is not set");
  process.exit(2);
}
const base = (process.env.BCONTEXT_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");

async function api(pathname) {
  const url = `${base}${pathname}${pathname.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspaceRef)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for GET ${pathname}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

/** Frontmatter `name` without a YAML dependency: the first `name:` key of the leading block. */
function frontmatterName(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md ?? "");
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => /^name\s*:/.test(l));
  if (!line) return null;
  return line.replace(/^name\s*:\s*/, "").trim().replace(/^["']|["']$/g, "");
}

async function main() {
  const skillIds = [];
  let cursor = null;
  do {
    const page = await api(`/api/nodes?fields=summary&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const n of page.nodes ?? []) if (n.kind === "skill") skillIds.push(n.id);
    cursor = page.next_cursor ?? null;
  } while (cursor);

  const seen = [];
  for (const id of skillIds) {
    const { node } = await api(`/api/nodes/${id}`);
    const name = frontmatterName(node.content_md);
    if (name) seen.push(name);
    if (name !== skillName) continue;
    const version = Number.isInteger(node.data?.version) ? node.data.version : 1;
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, node.content_md.replace(/\s+$/, "") + "\n");
    console.log(`wrote ${outPath} from skill ${name} v${version} (node ${node.id}, updated ${node.updated_at})`);
    return;
  }
  console.error(
    `skill "${skillName}" not found in ${workspaceRef}` +
      (seen.length ? `; skills there: ${seen.join(", ")}` : `; no skill nodes there`),
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
