/**
 * POST /api/upload — image upload endpoint backing the editor's
 * paste/drag/slash-image flows.
 *
 * Multipart form fields:
 *   - file       (required, image/png|jpeg|webp|gif, <= 4 MB)
 *   - workspace  (required, slug)
 *   - nodeId     (required, uuid of the node the image is embedded in)
 *   - ext        (optional, normalized extension; otherwise derived from mime)
 *
 * Auth: user session OR `nodes:write` bearer token. The agent token's
 * workspace must match the resolved workspace. Demo callers without
 * Supabase configured get a 503 — the client UI falls back to data URLs
 * before hitting this route.
 *
 * Storage: writes to the `node-images` bucket (public read) at
 *   `${workspace_id}/${nodeId}/${uuid}.${ext}`.
 * Returns: `{ url: <public_url> }`.
 */
import { randomUUID } from "node:crypto";
import { supabaseConfigured, toPublicSupabaseUrl } from "@/lib/env";
import { gate } from "@/lib/auth/require";
import { openWorkspaceForActor } from "@/lib/auth/workspace";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { withRoute } from "@/lib/route";
import { log } from "@bcontext-dev/contract/log";
import {
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  buildStorageKey,
  extensionFor,
  type AllowedImageMime,
} from "@bcontext-dev/contract/upload-image";

const BUCKET = "node-images";

export const POST = withRoute(async (req: Request) => {
  if (!supabaseConfigured()) {
    return Response.json(
      {
        error: "storage_unavailable",
        message: "Supabase is not configured on this server",
      },
      { status: 503 },
    );
  }

  // Authenticate before reading the body. Parsing a multipart upload is the
  // expensive part and the workspace is not known until it is parsed, so the
  // two halves are split: `gate` here, `openWorkspaceForActor` once the slug is
  // in hand. One gate, one rate-limit charge, and an anonymous caller cannot
  // make the server read megabytes.
  const gated = await gate(req, "nodes:write");
  if (gated instanceof Response) return gated;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json(
      { error: "bad_request", message: "expected multipart/form-data" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  const workspaceSlug = String(form.get("workspace") ?? "").trim();
  const nodeId = String(form.get("nodeId") ?? "").trim();
  const extOverride = String(form.get("ext") ?? "").trim();

  if (!workspaceSlug) {
    return Response.json(
      { error: "bad_request", message: "workspace is required" },
      { status: 400 },
    );
  }
  if (!nodeId) {
    return Response.json(
      { error: "bad_request", message: "nodeId is required" },
      { status: 400 },
    );
  }
  // `formData()` returns `File | string`. Treat anything without
  // `arrayBuffer()` as a string / missing field.
  if (
    !file ||
    typeof file === "string" ||
    typeof (file as Blob).arrayBuffer !== "function"
  ) {
    return Response.json(
      { error: "bad_request", message: "file is required" },
      { status: 400 },
    );
  }

  const blob = file as Blob & { name?: string };
  const mime = blob.type;
  if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(mime)) {
    return Response.json(
      { error: "invalid_type", message: `Unsupported image type: ${mime}` },
      { status: 415 },
    );
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    return Response.json(
      { error: "too_large", message: "Image exceeds 4 MB" },
      { status: 413 },
    );
  }

  // The workspace lives in the multipart body, so it cannot be known before
  const ctx = await openWorkspaceForActor(gated, workspaceSlug, "write");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;
  if (storage.backend !== "supabase") {
    // Demo workspace can't persist objects — the UI is supposed to take
    // the data-URL path before reaching here.
    return Response.json(
      {
        error: "storage_unavailable",
        message: "this workspace is demo-only; images are not persisted",
      },
      { status: 503 },
    );
  }
  const target = await storage.getNode(nodeId);
  if (!target) {
    return Response.json(
      { error: "node_not_found", message: "nodeId does not exist in this workspace" },
      { status: 404 },
    );
  }
  const ext = extOverride || extensionFor(mime as AllowedImageMime);
  const key = buildStorageKey({
    workspaceId: storage.workspace.id,
    nodeId,
    uuid: randomUUID(),
    ext,
  });

  const admin = getSupabaseAdmin();
  const arrayBuffer = await blob.arrayBuffer();
  const { error: uploadErr } = await admin.storage
    .from(BUCKET)
    .upload(key, Buffer.from(arrayBuffer), {
      contentType: mime,
      cacheControl: "31536000, immutable",
      upsert: false,
    });
  if (uploadErr) {
    log.error("upload.failed", {
      workspace_id: storage.workspace.id,
      node_id: nodeId,
      key,
      error: { message: uploadErr.message },
    });
    return Response.json(
      { error: "upload_failed", message: uploadErr.message },
      { status: 502 },
    );
  }

  const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(key);
  if (!pub?.publicUrl) {
    return Response.json(
      { error: "upload_failed", message: "could not resolve public URL" },
      { status: 500 },
    );
  }

  log.info("upload.completed", {
    workspace_id: storage.workspace.id,
    node_id: nodeId,
    key,
    bytes: blob.size,
  });

  return Response.json({ url: toPublicSupabaseUrl(pub.publicUrl), key }, { status: 201 });
});
