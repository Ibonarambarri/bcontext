/**
 * Node attachments. Files live in the existing public
 * `node-images` storage bucket (migration 0004) under
 * `<workspace_id>/<node_id>/<uuid>.<ext>`; their records live on
 * `node.data.attachments[]` so they travel with the node and render in
 * the UI without a new table.
 *
 * Supabase-only: the demo store has no blob storage. Callers on the demo
 * backend get a clear error instead of a silent no-op.
 */

import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Storage } from "@/lib/storage";
import { supabasePublicUrl } from "@/lib/env";

const ATTACHMENT_BUCKET = "node-images";
/** Mirrors the bucket's file_size_limit (4 MB). */
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** Mirrors the bucket's allowed_mime_types. */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface AttachmentRecord {
  path: string;
  filename: string;
  content_type: string;
  size: number;
  ts: string;
  uploaded_via: string;
}

/** Public object URL in the `node-images` bucket; the bucket is public by design. */
export function attachmentUrl(path: string): string {
  const base = (supabasePublicUrl() ?? "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${ATTACHMENT_BUCKET}/${path}`;
}

/** Read `data.attachments[]` defensively (missing/malformed → []). */
export function readAttachments(
  data: Record<string, unknown> | null | undefined,
): AttachmentRecord[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as Record<string, unknown>).attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v): v is AttachmentRecord =>
      !!v &&
      typeof v === "object" &&
      typeof (v as AttachmentRecord).path === "string" &&
      typeof (v as AttachmentRecord).filename === "string",
  );
}

export class AttachmentError extends Error {}

/**
 * Remove every stored object under `<workspaceId>/<nodeId>/` for each of
 * `nodeIds`. Called after a node delete: the DB cascade removes the rows,
 * but blobs would otherwise stay publicly reachable forever — screenshots
 * routinely contain sensitive data, so deletion must extend to storage.
 * Best-effort by design: callers fire-and-forget it.
 */
export async function cleanupAttachmentsFor(
  workspaceId: string,
  nodeIds: string[],
): Promise<void> {
  const admin = getSupabaseAdmin();
  const bucket = admin.storage.from(ATTACHMENT_BUCKET);
  for (const nodeId of nodeIds) {
    const prefix = `${workspaceId}/${nodeId}`;
    const { data: objects, error } = await bucket.list(prefix, { limit: 100 });
    if (error || !objects || objects.length === 0) continue;
    await bucket.remove(objects.map((o: { name: string }) => `${prefix}/${o.name}`));
  }
}

/**
 * Magic-byte check: the declared MIME must match the actual leading bytes,
 * otherwise arbitrary content gets served publicly under an image
 * content-type.
 */
function sniffMatches(bytes: Buffer, contentType: string): boolean {
  switch (contentType) {
    case "image/png":
      return bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47;
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
    case "image/webp":
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
    default:
      return false;
  }
}

/**
 * Validates type and size, uploads under `<workspace>/<node>/<uuid>.<ext>`
 * and appends the record to `data.attachments`. Errors are `AttachmentError`
 * so the route/tool can answer 400 instead of 500.
 */
export async function attachFile(
  storage: Storage,
  input: {
    nodeId: string;
    filename: string;
    contentBase64: string;
    contentType: string;
    uploadedVia: string;
  },
): Promise<{ record: AttachmentRecord; url: string; nodeTitle: string }> {
  if (storage.backend !== "supabase") {
    throw new AttachmentError(
      "attachments require a persisted (Supabase) workspace — the demo store has no blob storage",
    );
  }
  const ext = MIME_TO_EXT[input.contentType];
  if (!ext) {
    throw new AttachmentError(
      `unsupported content_type "${input.contentType}" — allowed: ${Object.keys(MIME_TO_EXT).join(", ")}`,
    );
  }

  // Node's Buffer.from(b64) never throws — it silently skips invalid
  // characters — so validate the alphabet explicitly.
  const b64 = input.contentBase64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new AttachmentError("content_base64 is not valid base64");
  }
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) {
    throw new AttachmentError("content_base64 decoded to 0 bytes");
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      `attachment is ${bytes.length} bytes — limit is ${MAX_ATTACHMENT_BYTES} (4 MB)`,
    );
  }
  if (!sniffMatches(bytes, input.contentType)) {
    throw new AttachmentError(
      `content does not look like ${input.contentType} (magic bytes mismatch) — the declared type must match the actual file`,
    );
  }

  const node = await storage.getNode(input.nodeId);
  if (!node) throw new AttachmentError(`node not found: ${input.nodeId}`);
  const admin = getSupabaseAdmin();
  const path = `${storage.workspace.id}/${node.id}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await admin.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, bytes, { contentType: input.contentType });
  if (upErr) throw new AttachmentError(`upload failed: ${upErr.message}`);

  const record: AttachmentRecord = {
    path,
    filename: input.filename,
    content_type: input.contentType,
    size: bytes.length,
    ts: new Date().toISOString(),
    uploaded_via: input.uploadedVia,
  };

  // Append to data.attachments with the optimistic guard: a concurrent
  // body edit must not be clobbered by our data merge (and vice versa).
  // One retry on a lost race, then surface the conflict.
  for (let attempt = 0; ; attempt++) {
    const fresh = attempt === 0 ? node : await storage.getNode(input.nodeId);
    if (!fresh) throw new AttachmentError(`node vanished: ${input.nodeId}`);
    const nextData = {
      ...(fresh.data ?? {}),
      attachments: [...readAttachments(fresh.data), record],
    };
    try {
      await storage.updateNode(
        input.nodeId,
        { data: nextData },
        { ifUpdatedAt: fresh.updated_at },
      );
      break;
    } catch (err) {
      if (attempt === 0) continue;
      // Orphaned object cleanup is best-effort; the storage path is
      // namespaced by node so a later re-attach never collides.
      void admin.storage.from(ATTACHMENT_BUCKET).remove([path]);
      throw err;
    }
  }

  return { record, url: attachmentUrl(path), nodeTitle: node.title };
}
