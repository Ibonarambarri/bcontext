/**
 * POST /api/workspaces/:ws/import — multipart upload of one `.md` or a zip
 * of them (what `export/route.ts` produces, or any Markdown tree), each file
 * becoming a node; directory names become tags.
 *
 * Write verb via `openWorkspace`. The archive is planned in full before
 * anything is written, and a failure midway compensates by deleting what it created — the
 * public operation is all-or-none even though the storage calls are not one
 * transaction. Only a workspace admin may introduce tags the taxonomy does
 * not have yet; anyone else gets the list of missing names back.
 */
import JSZip from "jszip";
import { record as recordActivity } from "@/lib/activity";
import { directoryTagsForPath, parseMarkdown } from "@/lib/import-md";
import type { KnowledgeNode, NodeKind, Priority, TaskStatus } from "@bcontext-dev/contract/types";
import { requireWorkspaceAdmin } from "@/lib/auth/require";
import { openWorkspace } from "@/lib/auth/workspace";
import {
  NodeWriteError,
  type Storage,
} from "@/lib/storage";
import { wsBroadcast } from "@/lib/collab/server-broadcast";
import { withRoute } from "@/lib/route";
import { normalizeTagNames } from "@bcontext-dev/contract/tags";
import { changePayload } from "@bcontext-dev/contract/changes";
import { log } from "@bcontext-dev/contract/log";

const MAX_FILE_SIZE = 8 * 1024 * 1024;

interface PlannedNode {
  path: string;
  title: string;
  kind: NodeKind;
  status: TaskStatus | null;
  priority: Priority | null;
  tags: string[];
  content_md: string;
}

class ImportValidationError extends Error {}

function responseError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "write");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;
  const canCreateTags = (await requireWorkspaceAdmin(actor, storage)) === null;

  if (!(req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    return responseError("multipart/form-data required");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return responseError("could not parse multipart body");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return responseError("missing 'file' field");
  const blob = file as File;
  if (blob.size > MAX_FILE_SIZE) {
    return responseError(`file too large (max ${MAX_FILE_SIZE} bytes)`, 413);
  }

  const rawParent = form.get("parent_id");
  const parentId = typeof rawParent === "string" && rawParent.trim()
    ? rawParent.trim()
    : null;
  if (parentId) {
    const parent = await storage.getNode(parentId);
    if (!parent) return responseError(`parent node "${parentId}" not found`);
  }

  try {
    const filename = blob.name || "upload";
    const lower = filename.toLowerCase();
    const plan = lower.endsWith(".md") || blob.type === "text/markdown"
      ? [planMarkdown(await blob.text(), filename, filename)]
      : lower.endsWith(".zip") || blob.type === "application/zip"
        ? await planZip(Buffer.from(await blob.arrayBuffer()))
        : null;
    if (!plan) throw new ImportValidationError("unsupported file type (expected .md or .zip)");
    if (plan.length === 0) throw new ImportValidationError("archive contained no importable markdown");

    const created = await applyPlan(storage, plan, parentId, canCreateTags);
    recordImported(storage, created);
    return Response.json({ created: created.length, nodes: created }, { status: 201 });
  } catch (error) {
    const clientMessage = error instanceof ImportValidationError || error instanceof NodeWriteError
      ? error.message
      : "import failed without partial writes";
    log.warn("workspace.import.failed", {
      workspace_id: storage.workspace.id,
      code: error instanceof NodeWriteError ? error.code : "import_failed",
    });
    return responseError(clientMessage);
  }
});

function planMarkdown(source: string, filename: string, path: string): PlannedNode {
  const parsed = parseMarkdown(source, filename);
  return {
    path,
    title: parsed.title,
    kind: parsed.kind,
    status: parsed.status,
    priority: parsed.priority,
    tags: normalizeTagNames([...directoryTagsForPath(path), ...parsed.tags]),
    content_md: parsed.content_md,
  };
}

async function planZip(buffer: Buffer): Promise<PlannedNode[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new ImportValidationError("could not read zip");
  }
  const planned: PlannedNode[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.toLowerCase().endsWith(".md")) continue;
    const base = entry.name.split("/").pop() ?? entry.name;
    if (base.toLowerCase() === "index.md") continue;
    let source: string;
    try {
      source = await entry.async("string");
    } catch {
      throw new ImportValidationError(`could not read ${entry.name}`);
    }
    planned.push(planMarkdown(source, base, entry.name));
  }
  return planned;
}

async function applyPlan(
  storage: Storage,
  plan: PlannedNode[],
  parentId: string | null,
  canCreateTags: boolean,
): Promise<KnowledgeNode[]> {
  const allTagNames = normalizeTagNames(plan.flatMap((node) => node.tags));
  const tagsByName = await storage.resolveTagIds(allTagNames);
  const missing = allTagNames.filter((name) => !tagsByName.has(name));
  if (missing.length > 0 && !canCreateTags) {
    throw new ImportValidationError(
      `Import contains new tags (${missing.join(", ")}); workspace owner/admin must create them first`,
    );
  }

  const createdTagIds: string[] = [];
  const createdNodes: KnowledgeNode[] = [];
  try {
    for (const name of missing) {
      const tag = await storage.createTag({ name });
      createdTagIds.push(tag.id);
      tagsByName.set(name, tag.id);
    }
    for (const planned of plan) {
      const node = await storage.createNode({
        title: planned.title,
        kind: planned.kind,
        parent_id: parentId,
        content_md: planned.content_md,
        status: planned.status,
        priority: planned.priority,
        data: { source: "import", import_path: planned.path },
        tag_ids: planned.tags.map((name) => tagsByName.get(name)!).filter(Boolean),
      });
      createdNodes.push(node);
    }
    return createdNodes;
  } catch (error) {
    // Compensation keeps the public operation all-or-none. SQL storage calls
    // are individually atomic; cleanup runs in reverse dependency order.
    for (const node of [...createdNodes].reverse()) {
      await storage.deleteNode(node.id).catch(() => false);
    }
    for (const tagId of [...createdTagIds].reverse()) {
      await storage.deleteTag(tagId).catch(() => false);
    }
    throw error;
  }
}

function recordImported(storage: Storage, created: KnowledgeNode[]): void {
  for (const node of created) {
    recordActivity(storage.workspace.id, "create", node.id, node.title, "import", {
      actorKind: "human",
      payload: changePayload({ after: node, via: "import", source: "import" }),
    });
    if (storage.backend === "supabase") {
      void wsBroadcast.nodeCreated(storage.workspace.id, node.id);
    }
  }
}
