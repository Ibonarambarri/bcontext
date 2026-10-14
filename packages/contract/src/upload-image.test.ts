import { describe, expect, test } from "vitest";
import {
  ALLOWED_IMAGE_MIME,
  ImageUploadError,
  MAX_IMAGE_BYTES,
  buildStorageKey,
  extensionFor,
  uploadImage,
  validateImage,
  type FileLike,
} from "./upload-image.js";

function fakeFile(opts: Partial<FileLike> = {}): FileLike {
  return {
    type: opts.type ?? "image/png",
    size: opts.size ?? 1024,
    name: opts.name ?? "x.png",
  };
}

describe("validateImage", () => {
  test("accepts every allowed mime type", () => {
    for (const mime of ALLOWED_IMAGE_MIME) {
      expect(validateImage(fakeFile({ type: mime }))).toBe(mime);
    }
  });

  test("rejects unsupported mime types with invalid_type", () => {
    expect.assertions(2);
    try {
      validateImage(fakeFile({ type: "image/heic" }));
    } catch (err) {
      expect(err).toBeInstanceOf(ImageUploadError);
      expect((err as ImageUploadError).code).toBe("invalid_type");
    }
  });

  test("rejects files at or above 4 MB with too_large", () => {
    expect.assertions(3);
    const tooBig = fakeFile({ type: "image/png", size: MAX_IMAGE_BYTES + 1 });
    try {
      validateImage(tooBig);
    } catch (err) {
      expect(err).toBeInstanceOf(ImageUploadError);
      expect((err as ImageUploadError).code).toBe("too_large");
      expect((err as ImageUploadError).message).toMatch(/4 MB/);
    }
  });

  test("accepts files exactly at the 4 MB limit", () => {
    const justFits = fakeFile({ type: "image/jpeg", size: MAX_IMAGE_BYTES });
    expect(validateImage(justFits)).toBe("image/jpeg");
  });

  test("rejects empty mime", () => {
    expect.assertions(2);
    try {
      validateImage(fakeFile({ type: "" }));
    } catch (err) {
      expect(err).toBeInstanceOf(ImageUploadError);
      expect((err as ImageUploadError).code).toBe("invalid_type");
    }
  });
});

describe("extensionFor", () => {
  test("normalizes jpeg to jpg and preserves others", () => {
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/webp")).toBe("webp");
    expect(extensionFor("image/gif")).toBe("gif");
  });
});

describe("buildStorageKey", () => {
  test("uses workspaceId/nodeId/uuid.ext", () => {
    expect(
      buildStorageKey({
        workspaceId: "ws-1",
        nodeId: "node-7",
        uuid: "abc-123",
        ext: "png",
      }),
    ).toBe("ws-1/node-7/abc-123.png");
  });
});

describe("uploadImage", () => {
  test("returns a data URL in demo mode without calling fetch", async () => {
    const png = new Blob(
      [Uint8Array.from([0x89, 0x50, 0x4e, 0x47])],
      { type: "image/png" },
    );
    // A `File` is a Blob with name + lastModified; jsdom isn't available
    // so we construct one via the global File constructor when present, or
    // fall back to the Blob with a fake `name`. The implementation only
    // reads `type`, `size`, and feeds the blob to FileReader.
    const file =
      typeof File !== "undefined"
        ? new File([png], "x.png", { type: "image/png" })
        : (Object.assign(png, { name: "x.png" }) as unknown as File);

    // node 20 ships a FileReader-less environment; shim a minimal one if
    // it's missing so the test can exercise the demo path.
    const originalFileReader = (globalThis as { FileReader?: unknown }).FileReader;
    if (!originalFileReader) {
      class FR {
        onload: ((this: FR) => void) | null = null;
        onerror: (() => void) | null = null;
        result: string | null = null;
        readAsDataURL(blob: Blob) {
          void blob.arrayBuffer().then((buf) => {
            const b64 = Buffer.from(buf).toString("base64");
            this.result = `data:${blob.type};base64,${b64}`;
            this.onload?.call(this);
          });
        }
      }
      (globalThis as { FileReader?: unknown }).FileReader = FR;
    }

    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    const out = await uploadImage(file, {
      supabaseEnabled: false,
      workspace: "acme/demo",
      nodeId: "n1",
      fetchImpl,
    });

    expect(fetchCalls).toBe(0);
    expect(out.mode).toBe("demo");
    expect(out.url.startsWith("data:image/png;base64,")).toBe(true);

    if (!originalFileReader) {
      delete (globalThis as { FileReader?: unknown }).FileReader;
    }
  });

  test("posts to /api/upload and returns the public URL in supabase mode", async () => {
    const png = new Blob(["x"], { type: "image/png" });
    const file =
      typeof File !== "undefined"
        ? new File([png], "x.png", { type: "image/png" })
        : (Object.assign(png, { name: "x.png" }) as unknown as File);

    let seenUrl = "";
    let seenMethod = "";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenMethod = init?.method ?? "GET";
      return new Response(
        JSON.stringify({ url: "https://cdn.example/ws/n/uuid.png" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const out = await uploadImage(file, {
      supabaseEnabled: true,
      workspace: "acme/bcontext",
      nodeId: "node-1",
      fetchImpl,
    });

    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("/api/upload");
    expect(out).toEqual({
      url: "https://cdn.example/ws/n/uuid.png",
      mode: "supabase",
    });
  });

  test("surfaces server error messages as ImageUploadError(upload_failed)", async () => {
    const png = new Blob(["x"], { type: "image/png" });
    const file =
      typeof File !== "undefined"
        ? new File([png], "x.png", { type: "image/png" })
        : (Object.assign(png, { name: "x.png" }) as unknown as File);

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "bucket missing" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    expect.assertions(2);
    try {
      await uploadImage(file, {
        supabaseEnabled: true,
        workspace: "acme/bcontext",
        nodeId: "n",
        fetchImpl,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ImageUploadError);
      expect((err as ImageUploadError).message).toMatch(/bucket missing/);
    }
  });

  test("rejects validation failures before touching fetch", async () => {
    const blob = new Blob(["x"], { type: "image/heic" });
    const file =
      typeof File !== "undefined"
        ? new File([blob], "x.heic", { type: "image/heic" })
        : (Object.assign(blob, { name: "x.heic" }) as unknown as File);

    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("");
    }) as typeof fetch;

    expect.assertions(3);
    try {
      await uploadImage(file, {
        supabaseEnabled: true,
        workspace: "acme/bcontext",
        nodeId: "n",
        fetchImpl,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ImageUploadError);
      expect((err as ImageUploadError).code).toBe("invalid_type");
    }
    expect(calls).toBe(0);
  });
});
