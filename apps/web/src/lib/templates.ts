import type { NodeKind } from "@bcontext-dev/contract/types";

/**
 * Default markdown bodies for newly-created nodes. Keyed by `NodeKind`.
 *
 * New kinds register their template here; the sidebar's New page flow and any
 * other create surfaces should consult `templateFor(kind)` to seed
 * `content_md`.
 */
const NODE_TEMPLATES: Partial<Record<NodeKind, string>> = {
  adr: [
    "## Status",
    "Proposed",
    "",
    "## Context",
    "",
    "## Decision",
    "",
    "## Consequences",
    "",
    "## Alternatives considered",
    "",
  ].join("\n"),
};

/** The seed body for a new node of `kind`; undefined when the kind starts empty. */
export function templateFor(kind: NodeKind): string | undefined {
  return NODE_TEMPLATES[kind];
}
