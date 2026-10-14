/**
 * Per-kind markdown skeletons applied when a node is created with an empty
 * body. H2 headings are deliberate: each becomes a stable, addressable
 * block (`/n/<id>#<block_id>`), so every decision written by any agent in
 * any session exposes the same `#context` / `#decision` / `#consequences`
 * anchors — cross-session consistency without a validation layer.
 */

import type { KnowledgeNode } from "@bcontext-dev/contract/types";

const KIND_SKELETONS: Partial<Record<KnowledgeNode["kind"], string>> = {
  decision: [
    "## Context",
    "",
    "_What situation forced a choice?_",
    "",
    "## Decision",
    "",
    "_What was decided, in one sentence._",
    "",
    "## Consequences",
    "",
    "_What becomes easier / harder. Follow-up tasks as `- [ ]` items._",
  ].join("\n"),
  adr: [
    "## Status",
    "",
    "proposed",
    "",
    "## Context",
    "",
    "## Decision",
    "",
    "## Consequences",
  ].join("\n"),
  meeting: [
    "## Attendees",
    "",
    "## Notes",
    "",
    "## Decisions",
    "",
    "## Action items",
    "",
    "- [ ] ",
  ].join("\n"),
  // A goal is read by whoever inherits it, months later, and the questions
  // they ask are always the same four: why then, what counts as done, what is
  // being measured, and what could sink it. `## Review log` is the one that
  // earns its place structurally — check-ins append there, so the history of
  // a goal never overwrites its statement.
  goal: [
    "## Why now",
    "",
    "_What makes this the objective for this window rather than later._",
    "",
    "## Definition of done",
    "",
    "_What is true when it is achieved, in one sentence._",
    "",
    "## Key results",
    "",
    "_Managed as `data.key_results` (goals_write). Notes on how each is measured go here._",
    "",
    "## Risks",
    "",
    "## Review log",
  ].join("\n"),
  bug: [
    "## Symptom",
    "",
    "## Reproduction",
    "",
    "## Expected vs actual",
    "",
    "## Fix",
  ].join("\n"),
};

/** Skeleton for `kind` when the caller supplied no body; `""` otherwise. */
export function skeletonFor(
  kind: KnowledgeNode["kind"],
  content_md: string | undefined,
): string {
  if (content_md && content_md.trim()) return content_md;
  return KIND_SKELETONS[kind] ?? content_md ?? "";
}
