/**
 * Client-side image upload pipeline for the TipTap editor.
 *
 * Two paths:
 *   1. Supabase mode — POST file to `/api/upload`, which writes to the
 *      `node-images` Storage bucket and returns a public URL.
 *   2. Demo mode — encode as a base64 data URL inline. Persists only in
 *      the markdown body; the caller surfaces a one-time toast warning.
 *
 * Validation lives here so paste/drag/file-picker code paths share the
 * exact same constraints. Keep this module pure (no React, no toast) so
 * it stays trivially testable under vitest's node environment.
 */
export const ALLOWED_IMAGE_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB

const MIME_TO_EXT: Record<AllowedImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export class ImageUploadError extends Error {
  code:
    | "invalid_type"
    | "too_large"
    | "upload_failed"
    | "read_failed"
    | "no_file";
  constructor(code: ImageUploadError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface FileLike {
  readonly type: string;
  readonly size: number;
  readonly name?: string;
}

/**
 * Validate mime + size. Throws `ImageUploadError` on failure. Returns the
 * narrowed mime when valid.
 */
export function validateImage(file: FileLike): AllowedImageMime {
  if (!file || !file.type) {
    throw new ImageUploadError("invalid_type", "Not an image");
  }
  if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(file.type)) {
    throw new ImageUploadError(
      "invalid_type",
      `Unsupported image type: ${file.type}. Allowed: PNG, JPEG, WebP, GIF.`,
    );
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    throw new ImageUploadError(
      "too_large",
      `Image is ${mb} MB. Maximum is 4 MB.`,
    );
  }
  return file.type as AllowedImageMime;
}

/**
 * Derive the on-disk extension for an allowed mime type. JPEG normalizes
 * to `jpg` so generated keys stay short and predictable.
 */
export function extensionFor(mime: AllowedImageMime): string {
  return MIME_TO_EXT[mime];
}

/**
 * Construct the canonical storage object key. Pure for tests; the
 * uploader passes the uuid in so randomness lives at the call site.
 */
export function buildStorageKey(args: {
  workspaceId: string;
  nodeId: string;
  uuid: string;
  ext: string;
}): string {
  const { workspaceId, nodeId, uuid, ext } = args;
  return `${workspaceId}/${nodeId}/${uuid}.${ext}`;
}

/**
 * Read a Blob/File as a data URL. Browser-only — wraps FileReader so the
 * editor's demo-mode fallback can stash images inline.
 */
export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new ImageUploadError("read_failed", "Could not read image file"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(
          new ImageUploadError("read_failed", "Unexpected reader output"),
        );
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
}

export interface UploadResult {
  url: string;
  mode: "supabase" | "demo";
}

export interface UploadDeps {
  /** When true, hit `/api/upload`; when false, fall back to a data URL. */
  supabaseEnabled: boolean;
  /** Workspace slug used for permission resolution by the API route. */
  /** `<org>/<workspace>` — what the API resolves a workspace by. */
  workspace: string;
  /** Node id — becomes the second path segment in the bucket key. */
  nodeId: string;
  /**
   * Injection points for tests. Default to the real `fetch` and
   * `crypto.randomUUID` at the call site.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Upload a single file. The caller is expected to have already paid the
 * cost of getting a `File`/`Blob` from a paste/drop event.
 *
 * Errors propagate as `ImageUploadError` — the UI converts them into
 * `toast.error()` messages.
 */
export async function uploadImage(
  file: File,
  deps: UploadDeps,
): Promise<UploadResult> {
  const mime = validateImage(file);

  if (!deps.supabaseEnabled) {
    const url = await readAsDataUrl(file);
    return { url, mode: "demo" };
  }

  const ext = extensionFor(mime);
  const fetchImpl = deps.fetchImpl ?? fetch;

  const form = new FormData();
  form.append("file", file);
  form.append("workspace", deps.workspace);
  form.append("nodeId", deps.nodeId);
  form.append("ext", ext);

  let res: Response;
  try {
    res = await fetchImpl("/api/upload", {
      method: "POST",
      body: form,
    });
  } catch (err) {
    throw new ImageUploadError(
      "upload_failed",
      err instanceof Error ? err.message : "Network error",
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body?.message || body?.error || "";
    } catch {
      // ignore — server returned non-JSON
    }
    throw new ImageUploadError(
      "upload_failed",
      detail || `Upload failed (${res.status})`,
    );
  }

  const body = (await res.json()) as { url?: string };
  if (!body?.url) {
    throw new ImageUploadError("upload_failed", "Upload returned no URL");
  }
  return { url: body.url, mode: "supabase" };
}

/**
 * Best-effort extractor: pull all `File` instances out of a clipboard or
 * drag transfer that match our allowed mime list. Returns an empty array
 * when nothing relevant is present.
 */
export function extractImageFiles(
  list: DataTransfer | DataTransferItemList | FileList | null | undefined,
): File[] {
  if (!list) return [];
  const out: File[] = [];
  // DataTransfer carries both .files and .items; .items also covers paste
  // events where some browsers populate items but not files.
  const transfer = (list as DataTransfer).items ? (list as DataTransfer) : null;
  if (transfer) {
    for (const item of Array.from(transfer.items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f && (ALLOWED_IMAGE_MIME as readonly string[]).includes(f.type)) {
          out.push(f);
        }
      }
    }
    if (out.length > 0) return out;
    // Fallback to .files when .items didn't surface anything useful.
    for (const f of Array.from(transfer.files ?? [])) {
      if ((ALLOWED_IMAGE_MIME as readonly string[]).includes(f.type)) {
        out.push(f);
      }
    }
    return out;
  }
  // Plain FileList
  for (const f of Array.from(list as FileList)) {
    if ((ALLOWED_IMAGE_MIME as readonly string[]).includes(f.type)) {
      out.push(f);
    }
  }
  return out;
}
