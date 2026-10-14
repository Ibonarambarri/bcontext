/**
 * The grouping key, derived here and nowhere else.
 *
 * A list of error EVENTS stops being readable on the second day: one retry
 * loop in the worker writes four thousand rows of a single bug and buries the
 * other eleven. `error_groups` is the unit an operator actually attends, and
 * the fingerprint is what decides which group a new occurrence falls into. So
 * this file is the whole difference between "an inbox" and "a list of twelve
 * problems".
 *
 * WHY THE COLLECTOR AND NOT THE REPORTER
 *   A client that picks its own grouping key can split one problem into a
 *   thousand — by hand, by accident, or just by shipping a new version with a
 *   different string. Deriving it on this side means the rule is one function,
 *   versioned, testable, and identical for the API, the worker, the web app
 *   and the browser.
 *
 * WHAT GOES IN
 *   `error_type + service + operation + the first three normalised stack
 *   frames`. The frames are what make two occurrences of the same bug meet:
 *   the top of a stack is the bug, the bottom is whoever happened to call it.
 *   Three is the compromise — one frame merges distinct bugs that share a
 *   helper (everything that throws inside `assertWorkspace`), ten splits one
 *   bug across every entry point that reaches it.
 *
 * WHY NORMALISE AT ALL
 *   Raw frames never repeat. They carry an absolute path that differs between
 *   a container and a laptop, a line number that moves with the next commit,
 *   a bundle hash that changes every deploy, and sometimes a uuid that is
 *   different for every single request. Left alone, every occurrence is its
 *   own group and the table is the flat event list we were trying not to
 *   build. Normalising is deliberately lossy: it throws away exactly the
 *   parts that vary between two occurrences of the SAME bug.
 *
 * WHEN THERE IS NO STACK
 *   The browser strips stacks from cross-origin scripts, and plenty of thrown
 *   values were never `Error`s. The fallback is `error_type + operation +
 *   normalised message` — worse, because a message carries ids and counts,
 *   which is precisely why `normalizeMessage` replaces them with placeholders
 *   before hashing.
 *
 * The output is opaque: nothing parses it, the database only needs it to be
 * stable and unique. 32 hex chars of sha256 — a truncation whose collision
 * odds over a table this size are not the thing that will break first.
 */
import { createHash } from "node:crypto";

/** Bump when the derivation changes. Old groups keep their old key and stop
 *  receiving events; new ones form alongside. That is the honest outcome —
 *  silently re-grouping history would make "first seen" a lie. */
const VERSION = "v1";

/** How many frames of the stack take part. See the module note. */
const FRAME_COUNT = 3;

/** Characters of the hex digest kept. */
const FINGERPRINT_LENGTH = 32;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /\b[^\s@]+@[^\s@.]+\.[^\s@]+\b/g;
const URL_RE = /\b(?:https?|file):\/\/\S+/gi;
/** Eight hex characters or more: a bundle hash, a sha, a request id. Applied
 *  after uuids so it does not eat half of one. */
const HEX_RE = /\b[0-9a-f]{8,}\b/gi;
/** Anything numeric. Line numbers are already gone by the time this runs on a
 *  frame; on a message this is the "expected 3, got 7" that would otherwise
 *  make every occurrence unique. */
const NUMBER_RE = /\d+/g;
/** Quoted runs of text — a node id, a tag name, a column. Whatever a message
 *  put in quotes is almost always the variable part of it. */
const QUOTED_RE = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g;

/**
 * A message with its variable parts replaced by placeholders, so that
 *
 *     node 8f1c…-… not found in workspace 4a2b…-…
 *     node 3e77…-… not found in workspace 91cd…-…
 *
 * hash to the same thing. Order matters: urls before hex (a url is full of
 * hex-looking segments), uuids before hex (a uuid is hex with dashes),
 * quotes before numbers (so `"3 of 4"` collapses once, not twice).
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(URL_RE, "<url>")
    .replace(EMAIL_RE, "<email>")
    .replace(UUID_RE, "<uuid>")
    .replace(QUOTED_RE, "<str>")
    .replace(HEX_RE, "<hash>")
    .replace(NUMBER_RE, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One stack frame reduced to "which function, in which file" — the two parts
 * that are the same for two occurrences of one bug.
 *
 * Handles the shapes Node and the browsers actually emit:
 *
 *     at Object.handler (/app/src/lib/nodes/write.ts:120:15)
 *     at async /app/dist/api.cjs:41822:9
 *     at handler (https://app.example.com/_next/static/chunks/4f3a2b1c.js:1:2401)
 *     at node:internal/process/task_queues:95:5
 *
 * What survives: the function name and the last two path segments. What does
 * not: the absolute prefix (differs between container and laptop), the
 * line:col (moves with the next commit), bundle hashes and uuids (change
 * every deploy / every request).
 */
export function normalizeFrame(frame: string): string {
  let text = frame.trim().replace(/^at\s+/, "").replace(/^async\s+/, "");

  // `fn (location)` splits into its two halves; a bare frame is all location.
  const paren = /^(.*?)\s*\((.*)\)\s*$/.exec(text);
  const fn = paren ? normalizeFunction(paren[1] ?? "") : "";
  let location = paren ? (paren[2] ?? "") : text;

  // Drop the trailing `:line` / `:line:col` first — everything downstream is
  // easier once the only remaining digits are ones that mean something.
  location = location.replace(/:\d+(?::\d+)?$/, "");
  // Strip the scheme and authority: `https://app.example.com/a/b` and
  // `file:///app/a/b` are the same file to anyone reading the group.
  location = location.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  // Query strings and fragments are cache-busting, never identity.
  location = location.replace(/[?#].*$/, "");
  // Two segments: enough to tell `nodes/write.ts` from `tags/write.ts`,
  // little enough that `/app/src/...` and `/Users/…/src/...` agree.
  const segments = location.split(/[\\/]/).filter(Boolean);
  location = segments.slice(-2).join("/");
  location = location.replace(UUID_RE, "<uuid>").replace(HEX_RE, "<hash>").replace(/\d{3,}/g, "<n>");

  return fn ? `${fn}@${location}` : location;
}

/** The callee, minus the receiver noise V8 prefixes it with and minus any
 *  id that got closed over into a generated name. */
function normalizeFunction(name: string): string {
  return name
    .replace(/^(?:new|get|set)\s+/, "")
    .replace(/^(?:Object|Module|Function|Generator|Promise)\./, "")
    .replace(UUID_RE, "<uuid>")
    .replace(HEX_RE, "<hash>")
    .replace(/\d{3,}/g, "<n>")
    .trim();
}

/**
 * The first `FRAME_COUNT` frames of a stack, normalised. Exported for the
 * tests, which assert on the intermediate value: when a fingerprint stops
 * grouping what it used to, this is the layer that tells you why.
 */
export function stackFrames(stack: string | undefined, count = FRAME_COUNT): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    // The first line of a V8 stack is `Name: message`, not a frame. Selecting
    // for `at ` also drops the source-snippet preamble Node prints for a
    // syntax error and the blank lines browsers leave behind.
    .filter((line) => /^\s*at\s+/.test(line))
    .slice(0, count)
    .map((line) => normalizeFrame(line))
    .filter((line) => line.length > 0);
}

/** What the fingerprint is computed from. A structural subset of
 *  `ErrorReport` so callers (and tests) need not build a whole report. */
export interface FingerprintInput {
  service: string;
  operation: string;
  error_type?: string | undefined;
  message: string;
  stack?: string | undefined;
}

/**
 * The grouping key for one report. Stable across restarts, deploys and
 * replicas: same inputs, same 32 hex characters, forever — which is what lets
 * two collector replicas upsert the same `error_groups` row.
 */
export function fingerprintFor(input: FingerprintInput): string {
  const frames = stackFrames(input.stack);
  const type = (input.error_type ?? "Error").trim() || "Error";
  // `service` is in the key of both branches, including the fallback. Two
  // services can share an operation name (`job:webhook.drain` runs in the
  // worker and, during the migration, in the API too) and telling them apart
  // is the first thing an operator does.
  const parts =
    frames.length > 0
      ? [VERSION, type, input.service, input.operation, ...frames]
      : [VERSION, type, input.service, input.operation, normalizeMessage(input.message)];

  // NUL as the separator, not a space: it cannot occur in any of the parts,
  // and joining on a printable character would let a crafted operation name
  // ("a b" against "a" + "b") collide with another group's key.
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, FINGERPRINT_LENGTH);
}
