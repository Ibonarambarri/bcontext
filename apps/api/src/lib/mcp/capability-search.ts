/**
 * `capability_search`: how an agent finds what it may call beyond the native
 * tools — the external tools behind the capability gateway and the
 * workspace's skills — without paying for their schemas on every turn.
 *
 * Called by the MCP server (`src/lib/mcp/server.ts`) with the caller's own
 * authorized tools (`listAuthorizedCapabilityTools`, re-read per call) and the
 * workspace's skill nodes. Everything here is in-process and lexical: no
 * embeddings, no database. The one thing that must not break is the `ref` a
 * hit carries — `<provider>/<capability>/<tool>` for an external tool,
 * `skill/<slug>` for a skill — because that is what `capability_call` takes
 * back, and an agent may hold one across sessions.
 */
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { AuthorizedCapabilityTool } from "@/lib/capabilities/types";
import { refPart } from "@/lib/capabilities/catalog";
import { parseSkillBody, type SkillFrontmatter } from "@/lib/skills/template";

export const SKILL_REF_PREFIX = "skill/";

/** How many hits still get their `input_schema` inline. Above it, names only. */
const INLINE_SCHEMA_UP_TO = 3;

export interface CapabilityHit {
  ref: string;
  kind: "external" | "skill";
  /** External tools only: the provider the ref starts with. */
  provider?: string;
  title: string;
  description: string;
  /** JSON Schema of `args`. Present on the exact-ref hit and when there are few hits. */
  input_schema?: Record<string, unknown>;
}

export interface CapabilitySearchResult {
  hits: CapabilityHit[];
  /** Matches before `limit`; when it is larger than `hits`, narrow the query. */
  total: number;
  /** Only when a hit was returned without its schema: how to get it. */
  hint?: string;
}

/** A skill as the search sees it: the node plus its parsed frontmatter. */
export interface SkillCandidate {
  node: KnowledgeNode;
  frontmatter: SkillFrontmatter;
}

/** One searchable thing, external or skill, with the text the ranking reads. */
interface Candidate {
  hit: CapabilityHit;
  /** The name a caller would type: the remote tool name or the skill name. */
  name: string;
  /** Where the tool sits: provider, capability key, capability title. */
  origin: string;
  description: string;
  schema: Record<string, unknown> | undefined;
}

/** Skill nodes as candidates; nodes with no frontmatter `name` are not skills and are skipped. */
export function skillCandidates(nodes: readonly KnowledgeNode[]): SkillCandidate[] {
  const out: SkillCandidate[] = [];
  for (const node of nodes) {
    if (node.kind !== "skill" || node.status === "archived") continue;
    const { frontmatter } = parseSkillBody(node.content_md ?? "");
    if (typeof frontmatter.name === "string" && frontmatter.name.trim()) out.push({ node, frontmatter });
  }
  return out;
}

/** The ref a skill is called by. The slug is the stable, readable half of the node. */
export function skillRef(node: Pick<KnowledgeNode, "slug">): string {
  return `${SKILL_REF_PREFIX}${node.slug}`;
}

/**
 * A skill ref is `skill/<slug>` and nothing after: an external ref always has
 * two slashes, so a provider that happens to be called "skill" cannot be
 * mistaken for one.
 */
export function isSkillRef(ref: string): boolean {
  return ref.startsWith(SKILL_REF_PREFIX) && !ref.slice(SKILL_REF_PREFIX.length).includes("/");
}

/**
 * Whether `ref` names this skill. The slug is canonical, but an agent that
 * read a skill id off `skills(op=list)` may pass that instead, and refusing
 * it would cost a turn for nothing.
 */
export function skillMatchesRef(node: Pick<KnowledgeNode, "id" | "slug">, ref: string): boolean {
  if (!isSkillRef(ref)) return false;
  const key = ref.slice(SKILL_REF_PREFIX.length);
  return key === node.slug || key === node.id;
}

/**
 * The frontmatter's field list as JSON Schema, so a skill's `input_schema`
 * reads like an external tool's and `args` is typed the same way in both.
 * `validateInput` is what actually checks the call; this only describes it.
 */
export function skillInputSchema(frontmatter: SkillFrontmatter): Record<string, unknown> {
  const fields = frontmatter.input_schema?.fields ?? [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = {
      type: field.type,
      ...(field.description ? { description: field.description } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
    };
    if (field.required) required.push(field.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export interface SearchInput {
  query: string;
  provider?: string;
  limit: number;
}

/**
 * Rank the caller's tools and skills against the query.
 *
 * Lexical on purpose: the corpus is a few hundred names at most and an agent
 * usually knows roughly what it wants ("create issue", "github", a ref it saw
 * earlier). An exact ref or exact name always comes first; after that, tokens
 * matching the name outweigh the provider and capability, which outweigh the
 * description. Nothing scores on being long.
 */
export function searchCapabilities(
  input: SearchInput,
  external: readonly AuthorizedCapabilityTool[],
  skills: readonly SkillCandidate[],
): CapabilitySearchResult {
  const query = input.query.trim();
  const queryLower = query.toLowerCase();
  const tokens = tokenize(query);
  const providerFilter = input.provider ? refPart(input.provider) : null;

  const candidates: Candidate[] = [
    ...external
      .filter((tool) => providerFilter === null || refPart(tool.provider) === providerFilter)
      .map(externalCandidate),
    ...skills
      .filter(() => providerFilter === null || providerFilter === "skill")
      .map(skillCandidate),
  ];

  const scored = candidates
    .map((candidate) => ({ candidate, score: score(candidate, queryLower, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.hit.ref.localeCompare(b.candidate.hit.ref));

  const page = scored.slice(0, input.limit);
  const inlineAll = page.length <= INLINE_SCHEMA_UP_TO;
  let withheld = false;
  const hits = page.map(({ candidate }) => {
    const exact = candidate.hit.ref.toLowerCase() === queryLower;
    if (!candidate.schema || !(inlineAll || exact)) {
      if (candidate.schema) withheld = true;
      return candidate.hit;
    }
    return { ...candidate.hit, input_schema: candidate.schema };
  });

  return {
    hits,
    total: scored.length,
    ...(withheld
      ? { hint: "Search again with the ref as the query (or narrow to ≤3 hits) to get input_schema before calling." }
      : {}),
  };
}

function externalCandidate(tool: AuthorizedCapabilityTool): Candidate {
  return {
    hit: {
      ref: tool.ref,
      kind: "external",
      provider: tool.provider,
      title: tool.remoteName,
      description: tool.description,
    },
    name: tool.remoteName,
    origin: `${tool.provider} ${tool.capabilityKey} ${tool.capabilityTitle}`,
    description: tool.description,
    schema: tool.inputSchema,
  };
}

function skillCandidate({ node, frontmatter }: SkillCandidate): Candidate {
  const name = frontmatter.name?.trim() || node.title;
  const description = frontmatter.description?.trim() || node.title;
  return {
    hit: { ref: skillRef(node), kind: "skill", title: name, description },
    name,
    origin: `skill ${node.title}`,
    description,
    schema: skillInputSchema(frontmatter),
  };
}

/**
 * Exact ref, then exact name, then per-token hits weighted by where they
 * land. A token that starts the name counts more than one buried in it; the
 * whole query appearing verbatim in the description is worth a little on top,
 * so "create issue" prefers the tool whose description says exactly that.
 */
function score(candidate: Candidate, queryLower: string, tokens: string[]): number {
  if (candidate.hit.ref.toLowerCase() === queryLower) return 1_000;
  const name = candidate.name.toLowerCase();
  if (name === queryLower) return 500;
  // No searchable token at all (`*`, punctuation): list everything, in ref order.
  if (tokens.length === 0) return 1;

  const origin = candidate.origin.toLowerCase();
  const description = candidate.description.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    if (name.startsWith(token)) total += 40;
    else if (name.includes(token)) total += 30;
    if (origin.includes(token)) total += 15;
    if (description.includes(token)) total += 5;
  }
  if (total === 0) return 0;
  if (name.includes(queryLower)) total += 50;
  else if (description.includes(queryLower)) total += 20;
  return total;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}
