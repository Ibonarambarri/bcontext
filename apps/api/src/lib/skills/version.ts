/**
 * Skill versioning.
 *
 * A `skill` node carries `data.version`: an integer that starts at 1 and is
 * bumped on every content change, whichever door the change comes through
 * (`nodes_write(op=update)`, REST PATCH, `skills_write(op=import)`). The
 * version is what lets a catalogue or a plugin tell "the skill changed" apart
 * from "the node was touched" without diffing bodies.
 */
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { UpdateNodePatch } from "@/lib/storage";

const FIRST_SKILL_VERSION = 1;

/** Integer version stored on the node; unversioned skills count as v1. */
export function skillVersion(data: unknown): number {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const v = (data as Record<string, unknown>).version;
    if (typeof v === "number" && Number.isInteger(v) && v >= FIRST_SKILL_VERSION) return v;
  }
  return FIRST_SKILL_VERSION;
}

/** `data` for a freshly created skill node. */
export function initialSkillData(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...extra, version: FIRST_SKILL_VERSION };
}

/**
 * Hook for the generic node-update paths: when a skill's body changes, fold
 * a version bump into the patch. Anything else (metadata patches, other
 * kinds, identical bodies) passes through untouched, so no-op writes stay
 * no-ops and `updated_at` is not bumped for nothing.
 */
export function withSkillVersionBump(
  before: KnowledgeNode | null,
  patch: UpdateNodePatch,
): UpdateNodePatch {
  if (!before || before.kind !== "skill") return patch;
  if (typeof patch.content_md !== "string") return patch;
  if (patch.content_md === before.content_md) return patch;
  const base = patch.data ?? before.data ?? {};
  return { ...patch, data: { ...base, version: skillVersion(before.data) + 1 } };
}
