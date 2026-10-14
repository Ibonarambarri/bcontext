/**
 * Markdown export helpers. A node is rendered as a single Markdown file
 * with schema-v2 YAML frontmatter (title, semantic kind, slug, status,
 * priority, tags) followed by `content_md`. Category and filesystem-tree
 * placement are intentionally absent.
 *
 * The output is intentionally minimal — no extra whitespace, no body
 * normalisation. Existing newlines in `content_md` are preserved so a
 * round-trip through the editor stays byte-stable for unchanged nodes.
 */
import { getNodeTags, type KnowledgeNode } from "@bcontext-dev/contract/types";

export interface ExportedMarkdown {
  filename: string;
  body: string;
}

function yamlEscape(value: string): string {
  // Quote when the value contains characters that would otherwise need YAML
  // parsing rules to interpret correctly. Newlines collapse to spaces.
  const flat = value.replace(/\r?\n/g, " ").trim();
  if (flat === "") return '""';
  if (/^[A-Za-z0-9_./-]+$/.test(flat)) return flat;
  return `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function frontmatter(node: KnowledgeNode): string {
  const lines: string[] = ["---"];
  lines.push("bcontext_schema: 2");
  lines.push(`bcontext_id: ${yamlEscape(node.id)}`);
  lines.push(`title: ${yamlEscape(node.title)}`);
  lines.push(`kind: ${yamlEscape(node.kind)}`);
  lines.push(`slug: ${yamlEscape(node.slug)}`);
  if (node.status) lines.push(`status: ${yamlEscape(node.status)}`);
  if (node.priority) lines.push(`priority: ${yamlEscape(node.priority)}`);
  const tags = getNodeTags(node);
  if (tags.length > 0) {
    lines.push(`tags: [${tags.map((t) => yamlEscape(t)).join(", ")}]`);
  }
  if (node.created_at) lines.push(`created_at: ${yamlEscape(node.created_at)}`);
  if (node.updated_at) lines.push(`updated_at: ${yamlEscape(node.updated_at)}`);
  lines.push("---");
  return lines.join("\n");
}

/**
 * Render a single node as Markdown with YAML frontmatter.
 * Returns the filename (`<slug>.md`) and the full body.
 */
export function exportNodeAsMarkdown(node: KnowledgeNode): ExportedMarkdown {
  const fm = frontmatter(node);
  const body = node.content_md ?? "";
  const sep = body.startsWith("\n") ? "" : "\n";
  const fullBody = `${fm}\n${sep}${body}`;
  const slug = (node.slug && node.slug.trim()) || node.id;
  return { filename: `${slug}.md`, body: fullBody };
}

