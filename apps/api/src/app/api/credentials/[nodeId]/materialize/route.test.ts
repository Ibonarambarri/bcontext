import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { writeCredential, emptyCredential } from "@bcontext-dev/contract/credentials";
import { GET } from "./route";

const SECRET = "sk_live_never_in_a_transcript";

function call(slug: string, nodeId: string, query = "") {
  const url = `http://localhost/api/credentials/${nodeId}/materialize?workspace=${slug}${query}`;
  return GET(new Request(url), { params: Promise.resolve({ nodeId }) });
}

describe("GET /api/credentials/:nodeId/materialize", () => {
  let slug: string;
  let credentialId: string;
  let docId: string;

  beforeEach(async () => {
    slug = `creds-mat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    createWorkspace({ name: "Materialize", slug });
    const storage = resolveDemoStorage(slug);
    if (!storage) throw new Error("demo storage missing");
    const credential = await storage.createNode({
      title: "Stripe — API keys",
      kind: "credential",
      parent_id: null,
      content_md: "",
      data: writeCredential({
        ...emptyCredential("api_key_pair", "prod"),
        service: "Stripe",
        fields: [
          { key: "public_key", name: "Public / publishable key", value: "pk_live_ok", secret: false },
          { key: "secret_key", name: "Secret key", value: SECRET, secret: true },
        ],
      }),
    });
    credentialId = credential.id;
    const doc = await storage.createNode({ title: "Runbook", kind: "doc", parent_id: null, content_md: "x", data: {} });
    docId = doc.id;
  });

  it("returns one field as plaintext, uncacheable and never as JSON", async () => {
    const response = await call(slug, credentialId, "&field=secret_key");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toBe(SECRET);
  });

  it("matches a field by its label as well as its key", async () => {
    const response = await call(slug, credentialId, "&field=Secret%20key");
    expect(await response.text()).toBe(SECRET);
  });

  it("renders the whole credential as quoted dotenv lines", async () => {
    const response = await call(slug, credentialId, "&format=env");
    const body = await response.text();
    expect(body.split("\n")).toEqual([
      "STRIPE_PUBLIC_KEY='pk_live_ok'",
      `STRIPE_SECRET_KEY='${SECRET}'`,
    ]);
  });

  it("refuses a bare call, and names the keys on an unknown field", async () => {
    expect((await call(slug, credentialId)).status).toBe(400);
    const unknown = await call(slug, credentialId, "&field=nope");
    expect(unknown.status).toBe(404);
    const body = (await unknown.json()) as { fields: string[] };
    expect(body.fields).toEqual(["public_key", "secret_key"]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("is 404 for a node that is not a credential", async () => {
    expect((await call(slug, docId, "&field=anything")).status).toBe(404);
  });
});
