/**
 * Client-bundle budgets for the two routes that matter: the workspace shell
 * (`/w/[org]/[ws]`) and the node editor (`/w/[org]/[ws]/n/[nodeId]`).
 *
 * Reads the client-reference manifests `next build` writes, sums the gzip size
 * of every chunk loaded synchronously on first paint (async chunks are the
 * point of the budget and do not count) and fails when a route grows past its
 * line. Runs as `npm run perf:budget`, last step of `scripts/verify.sh`, so a
 * heavy import cannot reach `dev` unnoticed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const shellManifest = join(process.cwd(), ".next", "server", "app", "w", "[org]", "[ws]", "page_client-reference-manifest.js");
const editorManifest = join(process.cwd(), ".next", "server", "app", "w", "[org]", "[ws]", "n", "[nodeId]", "page_client-reference-manifest.js");
if (!existsSync(shellManifest) || !existsSync(editorManifest)) throw new Error("run `npm run build` before perf:budget");

const shellBytes = gzipBytes(initialChunks(shellManifest));
const editorBytes = gzipBytes(initialChunks(editorManifest));
console.log(JSON.stringify({ shell_gzip_bytes: shellBytes, editor_route_gzip_bytes: editorBytes }, null, 2));
// Workspace-shell budget: 175 KB gzip (measured 155.1 KB on 2026-10-14 +
// ~12% headroom). The chat panel, the recharts dashboard chart, the Supabase
// browser SDK, the heavy modals and the mobile chat drawer are all async; the
// synchronous weight left is the chrome itself: HeroUI v3 and the app's own
// shell components (src/components/ui: sidebar, command palette), the
// overlay machinery of react-aria, and the app shell code (workspace-context,
// sidebar, realtime provider). Do NOT raise this number to absorb feature
// code — new heavy dependencies (charts, editors, markdown, SDKs) belong
// behind next/dynamic with a skeleton from src/components/skeletons/.
assertBudget("workspace shell", shellBytes, 175 * 1024);
assertBudget("node editor route", editorBytes, 300 * 1024);

function initialChunks(manifestPath) {
  const source = readFileSync(manifestPath, "utf8");
  const marker = source.indexOf(" = {", source.indexOf("] ="));
  const json = JSON.parse(source.slice(marker + 3).replace(/;\s*$/, ""));
  const chunks = new Set();
  for (const module of Object.values(json.clientModules ?? {})) {
    if (module.async) continue;
    for (const chunk of module.chunks ?? []) chunks.add(chunk.replace(/^\/_next\//, ""));
  }
  return [...chunks].map((chunk) => join(process.cwd(), ".next", chunk));
}
function gzipBytes(paths) {
  return paths.reduce((total, file) => total + gzipSync(readFileSync(file)).byteLength, 0);
}
function assertBudget(label, actual, budget) {
  if (actual > budget) throw new Error(`${label} is ${actual} gzip bytes; budget is ${budget}`);
}
