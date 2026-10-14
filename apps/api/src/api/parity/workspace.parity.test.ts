/**
 * Group: /api/workspaces, /api/nexo, /api/upload, /api/onboarding.
 *
 * The workspace routes are where the request stops being JSON: a multipart
 * upload in (`import`, `upload`), a zip out (`export`), a streamed NDJSON
 * body (`nexo`). Hono hands the handler `c.req.raw`, so a body that is read
 * once and never re-encoded should pass through untouched — this group is
 * where that is proven rather than assumed.
 *
 * Tests run without Supabase, so `gate` resolves every request to the demo
 * actor. Routes that exist only for a signed-in user (onboarding,
 * conversation writes, the member roster) can therefore only be
 * exercised on their refusal paths; the refusal is still a routing result and
 * still has to be the same one.
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { applyTemplateById } from "@/lib/templates/apply";
import { createApiApp } from "../app";
import type { RouteModule } from "../adapter";
import {
  assertParity,
  BASE_HEADERS,
  expectParity,
  snapshot,
  type ParityRequest,
  type Snapshot,
} from "./harness";
import * as workspaces from "@/app/api/workspaces/route";
import * as agentsMdRoute from "@/app/api/workspaces/[ws]/agents-md/route";
import * as applyTemplateRoute from "@/app/api/workspaces/[ws]/apply-template/route";
import * as digestRoute from "@/app/api/workspaces/[ws]/digest/route";
import * as exportWsRoute from "@/app/api/workspaces/[ws]/export/route";
import * as importWsRoute from "@/app/api/workspaces/[ws]/import/route";
import * as membersRoute from "@/app/api/workspaces/[ws]/members/route";
import * as nexo from "@/app/api/nexo/route";
import * as conversations from "@/app/api/nexo/conversations/route";
import * as conversationRoute from "@/app/api/nexo/conversations/[id]/route";
import * as upload from "@/app/api/upload/route";
import * as onboarding from "@/app/api/onboarding/create/route";

// Dynamic routes type `params` as `{ ws: string }` rather than the adapter's
// `Record<string, string>`. The generated table widens them the same way;
// this is that cast, once per module.
const asModule = (m: object) => m as RouteModule;
const agentsMd = asModule(agentsMdRoute);
const applyTemplate = asModule(applyTemplateRoute);
const digest = asModule(digestRoute);
const exportWs = asModule(exportWsRoute);
const importWs = asModule(importWsRoute);
const members = asModule(membersRoute);
const conversation = asModule(conversationRoute);

const app = createApiApp({
  serve: [
    "/api/workspaces",
    "/api/nexo",
    "/api/upload",
    "/api/onboarding",
  ],
});

// Every request here is the demo actor, and the demo actor is rate-limited by
// IP. Two calls per assertion across forty assertions would exhaust the
// `chat` bucket (30) halfway through the file, and a 429 on the second call
// only would read as a parity failure. One IP per test keeps buckets apart.
let ipCounter = 0;
function fromIp(): Record<string, string> {
  ipCounter += 1;
  return { "x-forwarded-for": `10.0.0.${ipCounter}` };
}

/** Same request, but from a browser on another site — the origin guard refuses it. */
const CROSS_SITE = { origin: "http://evil.example" } as const;

const MISSING = "no-such-workspace-parity";

const workspace = createWorkspace({
  name: "Parity workspace",
  slug: `parity-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
});
const storage = resolveDemoStorage(workspace.slug)!;
await storage.createNode({
  title: "Parity doc",
  kind: "doc",
  parent_id: null,
  content_md: "# Parity doc\n\nA body for retrieval to find.",
});

/**
 * Multipart is the case `buildRequest` does not cover, and the case that
 * matters most here: the body must be a stream Hono has not touched. A
 * `FormData` can only be sent once, so the caller passes a factory and two
 * requests are built from it.
 */
async function assertMultipartParity(
  module: RouteModule,
  r: Omit<ParityRequest, "body"> & { form: () => FormData },
): Promise<Snapshot> {
  const build = () =>
    new Request(`http://localhost${r.path}`, {
      method: r.method,
      headers: { ...BASE_HEADERS, ...(r.headers ?? {}) },
      body: r.form(),
    });
  const handler = module[r.method]!;
  const direct = await snapshot(
    await handler(build(), { params: Promise.resolve(r.params ?? {}) }),
    r.responseHeaders,
  );
  const viaHono = await snapshot(await app.request(build()), r.responseHeaders);
  expectParity({ direct, viaHono });
  return direct;
}

function markdownForm(): FormData {
  const form = new FormData();
  form.append(
    "file",
    new File(["# Imported by parity\n\nOne paragraph.\n"], "parity.md", { type: "text/markdown" }),
  );
  return form;
}

function imageForm(slug: string): FormData {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "pixel.png", { type: "image/png" }));
  form.append("workspace", slug);
  form.append("nodeId", "00000000-0000-4000-8000-000000000000");
  return form;
}

describe("parity: workspaces", () => {
  it("GET /api/workspaces", () => assertParity(app, workspaces, { method: "GET", path: "/api/workspaces", headers: fromIp() }));
  it("GET /api/workspaces from another site is still served (reads are not origin-guarded)", () =>
    assertParity(app, workspaces, { method: "GET", path: "/api/workspaces", headers: { ...fromIp(), ...CROSS_SITE } }));

  // The demo slug is derived from the name, so a name repeated twice collides
  // on the second create. A name with no slug characters falls back to a
  // random slug, which is what lets the same request succeed both ways —
  // `stable` then blanks the slug and id that legitimately differ.
  it("POST /api/workspaces", () =>
    assertParity(app, workspaces, { method: "POST", path: "/api/workspaces", headers: fromIp(), body: { name: "★★★" } }));
  it("POST /api/workspaces with a colliding slug", () =>
    assertParity(app, workspaces, {
      method: "POST",
      path: "/api/workspaces",
      headers: fromIp(),
      body: { name: "Collides", slug: workspace.slug },
    }));
  it("POST /api/workspaces with an invalid body", () =>
    assertParity(app, workspaces, { method: "POST", path: "/api/workspaces", headers: fromIp(), body: { name: "" } }));
  it("POST /api/workspaces with malformed JSON", () =>
    assertParity(app, workspaces, { method: "POST", path: "/api/workspaces", headers: fromIp(), body: "{not json" }));
  it("POST /api/workspaces from another site", () =>
    assertParity(app, workspaces, { method: "POST", path: "/api/workspaces", headers: { ...fromIp(), ...CROSS_SITE }, body: { name: "x" } }));

  it("GET /api/workspaces/:ws/agents-md", () =>
    assertParity(app, agentsMd, {
      method: "GET",
      path: `/api/workspaces/${workspace.slug}/agents-md`,
      params: { ws: workspace.slug },
      headers: fromIp(),
      responseHeaders: ["content-disposition", "cache-control"],
    }));
  it("GET /api/workspaces/:ws/agents-md as a CLAUDE.md download", () =>
    assertParity(app, agentsMd, {
      method: "GET",
      path: `/api/workspaces/${workspace.slug}/agents-md?format=claude-md&download=1`,
      params: { ws: workspace.slug },
      headers: fromIp(),
      responseHeaders: ["content-disposition", "cache-control"],
    }));
  it("GET /api/workspaces/:ws/agents-md for a missing workspace", () =>
    assertParity(app, agentsMd, {
      method: "GET",
      path: `/api/workspaces/${MISSING}/agents-md`,
      params: { ws: MISSING },
      headers: fromIp(),
    }));

  it("GET /api/workspaces/:ws/digest", () =>
    assertParity(app, digest, {
      method: "GET",
      path: `/api/workspaces/${workspace.slug}/digest`,
      params: { ws: workspace.slug },
      headers: fromIp(),
    }));
  it("GET /api/workspaces/:ws/digest for a missing workspace", () =>
    assertParity(app, digest, {
      method: "GET",
      path: `/api/workspaces/${MISSING}/digest`,
      params: { ws: MISSING },
      headers: fromIp(),
    }));
  it("PUT /api/workspaces/:ws/digest (the demo store has no clock)", () =>
    assertParity(app, digest, {
      method: "PUT",
      path: `/api/workspaces/${workspace.slug}/digest`,
      params: { ws: workspace.slug },
      headers: fromIp(),
      body: { enabled: true },
    }));
  it("PUT /api/workspaces/:ws/digest with an invalid body", () =>
    assertParity(app, digest, {
      method: "PUT",
      path: `/api/workspaces/${workspace.slug}/digest`,
      params: { ws: workspace.slug },
      headers: fromIp(),
      body: { cron: 7 },
    }));
  // Publishing twice on the same day refreshes the same node (201 then 200),
  // so the happy path cannot be run both ways; the route test covers it.
  it("POST /api/workspaces/:ws/digest with an invalid body", () =>
    assertParity(app, digest, {
      method: "POST",
      path: `/api/workspaces/${workspace.slug}/digest`,
      params: { ws: workspace.slug },
      headers: fromIp(),
      body: { days: 0 },
    }));
  it("POST /api/workspaces/:ws/digest for a missing workspace", () =>
    assertParity(app, digest, {
      method: "POST",
      path: `/api/workspaces/${MISSING}/digest`,
      params: { ws: MISSING },
      headers: fromIp(),
      body: {},
    }));

  it("GET /api/workspaces/:ws/apply-template", () =>
    assertParity(app, applyTemplate, {
      method: "GET",
      path: `/api/workspaces/${workspace.slug}/apply-template`,
      params: { ws: workspace.slug },
      headers: fromIp(),
    }));
  it("GET /api/workspaces/:ws/apply-template for a missing workspace", () =>
    assertParity(app, applyTemplate, {
      method: "GET",
      path: `/api/workspaces/${MISSING}/apply-template`,
      params: { ws: MISSING },
      headers: fromIp(),
    }));
  // Applying is idempotent by (parent, title). Applied once up front, both
  // runs report the same all-skipped result instead of the first creating
  // and the second skipping.
  it("POST /api/workspaces/:ws/apply-template", async () => {
    await applyTemplateById(storage, "indie-hacker");
    const direct = await assertParity(app, applyTemplate, {
      method: "POST",
      path: `/api/workspaces/${workspace.slug}/apply-template`,
      params: { ws: workspace.slug },
      headers: fromIp(),
      body: { template: "indie-hacker" },
    });
    expect(direct.status).toBe(201);
  });
  it("POST /api/workspaces/:ws/apply-template with an unknown template", () =>
    assertParity(app, applyTemplate, {
      method: "POST",
      path: `/api/workspaces/${workspace.slug}/apply-template`,
      params: { ws: workspace.slug },
      headers: fromIp(),
      body: { template: "no-such-template" },
    }));
  it("POST /api/workspaces/:ws/apply-template with an invalid body", () =>
    assertParity(app, applyTemplate, {
      method: "POST",
      path: `/api/workspaces/${workspace.slug}/apply-template`,
      params: { ws: workspace.slug },
      headers: fromIp(),
      body: { template: "" },
    }));
  it("POST /api/workspaces/:ws/apply-template for a missing workspace", () =>
    assertParity(app, applyTemplate, {
      method: "POST",
      path: `/api/workspaces/${MISSING}/apply-template`,
      params: { ws: MISSING },
      headers: fromIp(),
      body: { template: "indie-hacker" },
    }));

  // JSZip stamps every entry with "now" at two-second DOS resolution, so two
  // otherwise identical archives can differ in bytes when the calls straddle
  // a boundary. Byte length and the unpacked entries are what the archive
  // promises; those are compared instead of the raw text.
  it("GET /api/workspaces/:ws/export", async () => {
    const r = {
      method: "GET" as const,
      path: `/api/workspaces/${workspace.slug}/export`,
      headers: { ...BASE_HEADERS, ...fromIp() },
    };
    const direct = await exportWsRoute.GET(new Request(`http://localhost${r.path}`, r), {
      params: Promise.resolve({ ws: workspace.slug }),
    });
    const viaHono = await app.request(new Request(`http://localhost${r.path}`, r));

    const unpack = async (res: Response): Promise<Snapshot> => {
      const bytes = await res.arrayBuffer();
      const zip = await JSZip.loadAsync(bytes);
      const entries: Record<string, string> = {};
      for (const name of Object.keys(zip.files).sort()) {
        entries[name] = await zip.files[name]!.async("string");
      }
      return {
        status: res.status,
        contentType: res.headers.get("content-type"),
        headers: {
          "content-disposition": res.headers.get("content-disposition"),
          "cache-control": res.headers.get("cache-control"),
        },
        body: { byteLength: bytes.byteLength, entries },
      };
    };
    const snapshots = { direct: await unpack(direct), viaHono: await unpack(viaHono) };
    expectParity(snapshots);
    expect(snapshots.direct.status).toBe(200);
    expect(snapshots.direct.contentType).toBe("application/zip");
    expect(Object.keys((snapshots.direct.body as { entries: Record<string, string> }).entries)).toContain("index.md");
  });
  it("GET /api/workspaces/:ws/export for a missing workspace", () =>
    assertParity(app, exportWs, {
      method: "GET",
      path: `/api/workspaces/${MISSING}/export`,
      params: { ws: MISSING },
      headers: fromIp(),
    }));

  it("POST /api/workspaces/:ws/import", async () => {
    const direct = await assertMultipartParity(importWs, {
      method: "POST",
      path: `/api/workspaces/${workspace.slug}/import`,
      params: { ws: workspace.slug },
      headers: fromIp(),
      form: markdownForm,
    });
    expect(direct.status).toBe(201);
    expect(direct.body).toMatchObject({ created: 1 });
  });
  it("POST /api/workspaces/:ws/import without a multipart body", () =>
    assertParity(app, importWs, {
      method: "POST",
      path: `/api/workspaces/${workspace.slug}/import`,
      params: { ws: workspace.slug },
      headers: fromIp(),
      body: { file: "not a file" },
    }));
  it("POST /api/workspaces/:ws/import with a multipart body missing the file", () =>
    assertMultipartParity(importWs, {
      method: "POST",
      path: `/api/workspaces/${workspace.slug}/import`,
      params: { ws: workspace.slug },
      headers: fromIp(),
      form: () => {
        const form = new FormData();
        form.append("parent_id", "");
        return form;
      },
    }));
  it("POST /api/workspaces/:ws/import for a missing workspace", () =>
    assertMultipartParity(importWs, {
      method: "POST",
      path: `/api/workspaces/${MISSING}/import`,
      params: { ws: MISSING },
      headers: fromIp(),
      form: markdownForm,
    }));

  it("GET /api/workspaces/:ws/members", () =>
    assertParity(app, members, {
      method: "GET",
      path: `/api/workspaces/${workspace.slug}/members`,
      params: { ws: workspace.slug },
      headers: fromIp(),
    }));
  it("GET /api/workspaces/:ws/members for a missing workspace", () =>
    assertParity(app, members, {
      method: "GET",
      path: `/api/workspaces/${MISSING}/members`,
      params: { ws: MISSING },
      headers: fromIp(),
    }));
});

describe("parity: nexo", () => {
  const RAG_HEADERS = [
    "x-rag-scope",
    "x-rag-scope-size",
    "x-rag-workspace-size",
    "x-rag-can-expand",
    "x-rag-expanded",
    "x-citations",
  ];

  // No AI gateway key in tests, so the route answers with its NDJSON stub —
  // which is the streamed content-type and sidecar headers the UI parses,
  // and all this process can prove without a model.
  it("POST /api/nexo", async () => {
    const direct = await assertParity(app, nexo, {
      method: "POST",
      path: "/api/nexo",
      headers: fromIp(),
      body: { workspace: workspace.slug, messages: [{ role: "user", content: "What is the parity doc?" }] },
      responseHeaders: RAG_HEADERS,
    });
    expect(direct.status).toBe(200);
    expect(direct.contentType).toContain("application/x-ndjson");
    expect(direct.body).toContain('"type":"finish"');
  });
  it("POST /api/nexo without a workspace", () =>
    assertParity(app, nexo, {
      method: "POST",
      path: "/api/nexo",
      headers: fromIp(),
      body: { messages: [{ role: "user", content: "hi" }] },
    }));
  it("POST /api/nexo for a missing workspace", () =>
    assertParity(app, nexo, {
      method: "POST",
      path: "/api/nexo",
      headers: fromIp(),
      body: { workspace: MISSING, messages: [{ role: "user", content: "hi" }] },
    }));
  it("POST /api/nexo with an invalid scope", () =>
    assertParity(app, nexo, {
      method: "POST",
      path: "/api/nexo",
      headers: fromIp(),
      body: { workspace: workspace.slug, messages: [], scope: { type: "bogus" } },
    }));
  it("POST /api/nexo with malformed JSON", () =>
    assertParity(app, nexo, { method: "POST", path: "/api/nexo", headers: fromIp(), body: "{" }));

  it("GET /api/nexo/conversations", () =>
    assertParity(app, conversations, {
      method: "GET",
      path: `/api/nexo/conversations?workspace=${workspace.slug}`,
      headers: fromIp(),
    }));
  it("GET /api/nexo/conversations without a workspace", () =>
    assertParity(app, conversations, { method: "GET", path: "/api/nexo/conversations", headers: fromIp() }));
  it("POST /api/nexo/conversations", () =>
    assertParity(app, conversations, {
      method: "POST",
      path: "/api/nexo/conversations",
      headers: fromIp(),
      body: { workspace: workspace.slug, title: "Parity" },
    }));
  it("POST /api/nexo/conversations from another site", () =>
    assertParity(app, conversations, {
      method: "POST",
      path: "/api/nexo/conversations",
      headers: { ...fromIp(), ...CROSS_SITE },
      body: { workspace: workspace.slug },
    }));

  const convId = "11111111-1111-4111-8111-111111111111";
  it("GET /api/nexo/conversations/:id", () =>
    assertParity(app, conversation, {
      method: "GET",
      path: `/api/nexo/conversations/${convId}`,
      params: { id: convId },
      headers: fromIp(),
    }));
  it("GET /api/nexo/conversations/:id with a non-uuid id", () =>
    assertParity(app, conversation, {
      method: "GET",
      path: "/api/nexo/conversations/not-a-conversation",
      params: { id: "not-a-conversation" },
      headers: fromIp(),
    }));
  it("PATCH /api/nexo/conversations/:id", () =>
    assertParity(app, conversation, {
      method: "PATCH",
      path: `/api/nexo/conversations/${convId}`,
      params: { id: convId },
      headers: fromIp(),
      body: { title: "Renamed" },
    }));
  it("PATCH /api/nexo/conversations/:id from another site", () =>
    assertParity(app, conversation, {
      method: "PATCH",
      path: `/api/nexo/conversations/${convId}`,
      params: { id: convId },
      headers: { ...fromIp(), ...CROSS_SITE },
      body: { title: "" },
    }));
  it("DELETE /api/nexo/conversations/:id", () =>
    assertParity(app, conversation, {
      method: "DELETE",
      path: `/api/nexo/conversations/${convId}`,
      params: { id: convId },
      headers: fromIp(),
    }));
  it("DELETE /api/nexo/conversations/:id from another site", () =>
    assertParity(app, conversation, {
      method: "DELETE",
      path: `/api/nexo/conversations/${convId}`,
      params: { id: convId },
      headers: { ...fromIp(), ...CROSS_SITE },
    }));
});

describe("parity: upload", () => {
  // Without Supabase the route refuses before it reads the body, so this
  // proves the multipart request reaches the same refusal, not the parse.
  // The parse itself is proven on /import above, which does read it.
  it("POST /api/upload", async () => {
    const direct = await assertMultipartParity(upload, {
      method: "POST",
      path: "/api/upload",
      headers: fromIp(),
      form: () => imageForm(workspace.slug),
    });
    expect(direct.status).toBe(503);
  });
  it("POST /api/upload without a multipart body", () =>
    assertParity(app, upload, { method: "POST", path: "/api/upload", headers: fromIp(), body: { file: "x" } }));
  it("POST /api/upload from another site", () =>
    assertMultipartParity(upload, {
      method: "POST",
      path: "/api/upload",
      headers: { ...fromIp(), ...CROSS_SITE },
      form: () => imageForm(MISSING),
    }));
});

describe("parity: onboarding", () => {
  it("POST /api/onboarding/create", () =>
    assertParity(app, onboarding, {
      method: "POST",
      path: "/api/onboarding/create",
      headers: fromIp(),
      body: { name: "Parity Co", template: "indie-hacker" },
    }));
  it("POST /api/onboarding/create with an invalid body", () =>
    assertParity(app, onboarding, {
      method: "POST",
      path: "/api/onboarding/create",
      headers: fromIp(),
      body: { name: "" },
    }));
  it("POST /api/onboarding/create from another site", () =>
    assertParity(app, onboarding, {
      method: "POST",
      path: "/api/onboarding/create",
      headers: { ...fromIp(), ...CROSS_SITE },
      body: { name: "Parity Co" },
    }));
});
