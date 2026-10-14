/**
 * Apply a WorkspaceTemplate to a Storage instance. Idempotent: nodes
 * whose (parent, title) pair already exists are skipped. Returns the
 * set of created and skipped node keys so the caller can report.
 */
import type { Storage } from "@/lib/storage";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { getTemplate, type WorkspaceTemplate } from "@bcontext-dev/contract/templates/workspaces";
import { normalizeTagNames } from "@bcontext-dev/contract/tags";

export interface ApplyResult {
  template: string;
  created: { key: string; id: string }[];
  skipped: { key: string; reason: string }[];
}

export async function applyTemplateById(
  storage: Storage,
  templateId: string,
): Promise<ApplyResult> {
  const tpl = getTemplate(templateId);
  if (!tpl) throw new Error(`Unknown template: ${templateId}`);
  return applyTemplate(storage, tpl);
}

export async function applyTemplate(
  storage: Storage,
  template: WorkspaceTemplate,
): Promise<ApplyResult> {
  const existing = await storage.listNodes();
  // Index existing nodes by (parent_id || ROOT) + title to dedupe.
  const seen = new Map<string, string>(); // key -> id
  for (const n of existing) {
    seen.set(keyOf(n.parent_id, n.title), n.id);
  }

  const created: { key: string; id: string }[] = [];
  const skipped: { key: string; reason: string }[] = [];
  const keyToId = new Map<string, string>(); // template key -> created id
  const templateTagNames = normalizeTagNames(
    template.nodes.flatMap((node) => node.tags ?? []),
  );
  const tagIdByName = await storage.resolveTagIds(templateTagNames);

  for (const tn of template.nodes) {
    const parentId = tn.parent ? keyToId.get(tn.parent) ?? null : null;
    // If the template references an unresolved parent, that means the
    // parent itself was skipped because it already existed: look it up
    // among the existing nodes by title at root level (templates always
    // anchor a parent at one level above its children).
    const resolvedParentId =
      parentId ??
      (tn.parent
        ? lookupExistingByTitle(existing, tn.parent, template)
        : null);

    const dedupeKey = keyOf(resolvedParentId, tn.title);
    if (seen.has(dedupeKey)) {
      const existingId = seen.get(dedupeKey)!;
      keyToId.set(tn.key, existingId);
      skipped.push({ key: tn.key, reason: "already exists" });
      continue;
    }

    const tagNames = normalizeTagNames(tn.tags ?? []);
    const missingTag = tagNames.find((name) => !tagIdByName.has(name));
    if (missingTag) {
      throw new Error(`Template references missing workspace tag: ${missingTag}`);
    }
    const node = await storage.createNode({
      title: tn.title,
      kind: tn.kind,
      parent_id: resolvedParentId,
      content_md: tn.content_md ?? "",
      slug: tn.slug,
      tag_ids: tagNames.map((name) => tagIdByName.get(name)!),
    });
    keyToId.set(tn.key, node.id);
    seen.set(dedupeKey, node.id);
    created.push({ key: tn.key, id: node.id });
  }

  // One coarse refresh for the whole batch rather than N node.created events.
  if (created.length > 0 && storage.backend === "supabase") {
    void wsBroadcast.treeInvalidated(storage.workspace.id);
  }

  return {
    template: template.id,
    created,
    skipped,
  };
}

function keyOf(parentId: string | null, title: string): string {
  return `${parentId ?? "ROOT"}::${title.toLowerCase()}`;
}

function lookupExistingByTitle(
  existing: { id: string; parent_id: string | null; title: string }[],
  templateKey: string,
  template: WorkspaceTemplate,
): string | null {
  // Resolve the template key → expected title, then match against existing.
  const expected = template.nodes.find((n) => n.key === templateKey);
  if (!expected) return null;
  const expectedParentId = expected.parent
    ? lookupExistingByTitle(existing, expected.parent, template)
    : null;
  const match = existing.find(
    (e) =>
      e.parent_id === expectedParentId &&
      e.title.toLowerCase() === expected.title.toLowerCase(),
  );
  return match?.id ?? null;
}
