/**
 * Skill import — the inverse of `skills_push`.
 *
 * Takes a SKILL.md-shaped markdown (frontmatter with `name`) and upserts the
 * `skill` node that carries it, keyed by the frontmatter name. A new skill
 * starts at `data.version = 1`; a changed body bumps it; an identical body is
 * a no-op that leaves `updated_at` alone. `source` (a catalogue URL, a repo
 * path) is kept in `data.source` so a workspace can tell where a skill came
 * from and re-import from there.
 */
import matter from "gray-matter";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { Storage } from "@/lib/storage";
import { SkillError, parseSkillBody } from "./template";
import { initialSkillData, skillVersion } from "./version";

export interface ImportSkillInput {
  name: string;
  body_md: string;
  source?: string;
}

export interface ImportSkillResult {
  node: KnowledgeNode;
  /** No node matched the frontmatter name, so this call created one. */
  created: boolean;
  /** Body differed from what was stored (always true on create). */
  changed: boolean;
  version: number;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

/** Upsert by frontmatter name; result says whether it was created, updated or unchanged. */
export async function importSkill(
  storage: Storage,
  input: ImportSkillInput,
): Promise<ImportSkillResult> {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) {
    throw new SkillError(`invalid skill name: "${name}" (letters, digits, . _ -)`);
  }
  const body = normalizeBody(name, input.body_md);
  const { frontmatter } = parseSkillBody(body);
  const title = frontmatter.title?.trim() || name;

  const existing = await findSkillByName(storage, name);
  if (!existing) {
    const node = await storage.createNode({
      kind: "skill",
      title,
      parent_id: null,
      content_md: body,
      data: initialSkillData(input.source ? { source: input.source } : {}),
      status: null,
    });
    return { node, created: true, changed: true, version: skillVersion(node.data) };
  }

  const sourceChanged = Boolean(input.source) && existing.data.source !== input.source;
  if (existing.content_md === body && !sourceChanged) {
    return { node: existing, created: false, changed: false, version: skillVersion(existing.data) };
  }
  const bodyChanged = existing.content_md !== body;
  const version = bodyChanged ? skillVersion(existing.data) + 1 : skillVersion(existing.data);
  const node = await storage.updateNode(existing.id, {
    ...(bodyChanged ? { content_md: body } : {}),
    ...(existing.title !== title ? { title } : {}),
    data: {
      ...existing.data,
      version,
      ...(input.source ? { source: input.source } : {}),
    },
  });
  if (!node) throw new SkillError(`skill not found: ${existing.id}`, 404);
  return { node, created: false, changed: bodyChanged, version };
}

/**
 * The stored body must open with frontmatter that names the skill, because
 * that is how `skills(op=list)` and the exporters find it. A body whose
 * frontmatter names a different skill is refused; one without `name` gets it
 * written in.
 */
function normalizeBody(name: string, raw: string): string {
  const md = raw.replace(/^﻿/, "").replace(/^\s*\n/, "");
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(md);
  } catch (err) {
    throw new SkillError(`body_md frontmatter does not parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  const declared = typeof fm.name === "string" ? fm.name.trim() : "";
  if (declared && declared !== name) {
    throw new SkillError(`frontmatter name "${declared}" does not match name "${name}"`);
  }
  if (declared && md.startsWith("---")) return md.replace(/\s+$/, "") + "\n";
  const content = parsed.content.replace(/^\n+/, "").replace(/\s+$/, "");
  return matter.stringify(`\n${content}\n`, { name, ...fm }).replace(/\s+$/, "") + "\n";
}

async function findSkillByName(
  storage: Storage,
  name: string,
): Promise<KnowledgeNode | null> {
  const nodes = await storage.listNodes();
  for (const node of nodes) {
    if (node.kind !== "skill") continue;
    const { frontmatter } = parseSkillBody(node.content_md ?? "");
    if (frontmatter.name?.trim() === name) return node;
  }
  return null;
}
