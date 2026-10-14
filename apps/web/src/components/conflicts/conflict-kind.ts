/**
 * The one place the Conflicts list and panel agree on how a conflict kind
 * looks — kept out of the components so it stays a pure function.
 */
import type { NexoConflictKind } from "@/lib/integrations/types";

/** Chip colour per kind: a contradiction is a caution, a doubt is a question, stale is neutral. */
export function conflictKindTone(kind: NexoConflictKind): "warning" | "accent" | "default" {
  if (kind === "contradiction") return "warning";
  if (kind === "doubt") return "accent";
  return "default";
}
