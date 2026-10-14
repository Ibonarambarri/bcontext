/** Folderless Markdown import parsing. */
import matter from "gray-matter";
import type {
  NodeKind,
  Priority,
  TaskStatus,
} from "@bcontext-dev/contract/types";
import { normalizeTagNames } from "@bcontext-dev/contract/tags";

const VALID_KINDS: readonly NodeKind[] = [
  "doc",
  "task",
  "decision",
  "meeting",
  "bug",
  "adr",
  "entity",
  "skill",
] as const;

const LEGACY_FRONTMATTER_TAGS = [
  "business",
  "product",
  "tech",
  "decisions",
  "meetings",
  "tasks",
  "bugs",
  "ai",
] as const;

const VALID_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "blocked",
  "done",
] as const;

const VALID_PRIORITIES: readonly Priority[] = ["low", "med", "high", "urgent"] as const;

export interface ParsedMarkdown {
  title: string;
  kind: NodeKind;
  status: TaskStatus | null;
  priority: Priority | null;
  /** Canonical tags, including a valid legacy frontmatter category. */
  tags: string[];
  content_md: string;
}

function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.md$/i, "");
  const last = base.split("/").pop() ?? base;
  if (!last) return "Untitled";
  return last
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase());
}

function pickString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * One markdown file → node fields. Frontmatter supplies kind, status, tags
 * and title (the filename when absent); malformed YAML keeps the body
 * instead of failing the import.
 */
export function parseMarkdown(source: string, filename: string): ParsedMarkdown {
  let frontmatter: Record<string, unknown> = {};
  let content = source;
  try {
    const parsed = matter(source);
    frontmatter = (parsed.data ?? {}) as Record<string, unknown>;
    content = parsed.content;
  } catch {
    // Preserve the body when hand-written YAML is malformed.
  }

  const rawKind = pickString(frontmatter.kind);
  const kind = rawKind && (VALID_KINDS as readonly string[]).includes(rawKind)
    ? rawKind as NodeKind
    : "doc";
  const rawCategory = pickString(frontmatter.category)?.toLowerCase();
  const categoryTag = rawCategory && (LEGACY_FRONTMATTER_TAGS as readonly string[]).includes(rawCategory)
    ? rawCategory
    : null;
  const rawStatus = pickString(frontmatter.status);
  const status = rawStatus && (VALID_STATUSES as readonly string[]).includes(rawStatus)
    ? rawStatus as TaskStatus
    : null;
  const rawPriority = pickString(frontmatter.priority);
  const priority = rawPriority && (VALID_PRIORITIES as readonly string[]).includes(rawPriority)
    ? rawPriority as Priority
    : null;
  const explicitTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];

  return {
    title: pickString(frontmatter.title) ?? titleFromFilename(filename),
    kind,
    status,
    priority,
    tags: normalizeTagNames([...explicitTags, ...(categoryTag ? [categoryTag] : [])]),
    content_md: content.replace(/^\n+/, ""),
  };
}

/** Every directory segment becomes an accumulated classification tag. */
export function directoryTagsForPath(path: string): string[] {
  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .slice(0, -1)
    .map((segment) => segment.replace(/[-_]+/g, " "));
  return normalizeTagNames(segments);
}
