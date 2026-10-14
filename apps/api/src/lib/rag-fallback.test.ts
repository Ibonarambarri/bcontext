import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keywordForced, retrieveScoped } from "./rag";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import type { Storage } from "@/lib/storage";

/**
 * Without embeddings, retrieval falls back to a keyword scorer. It has to
 * read the storage the caller holds. It read the in-memory demo store, which
 * is empty for a Supabase workspace, and a workspace without an AI gateway key
 * answered every search with zero hits over content that was plainly there —
 * the agent lab's reviewer found it on day one, grading three questions at 0/3.
 *
 * The demo storage stands in for "a real storage the demo-store map does not
 * know about": a wrapper with backend "supabase" whose nodes come only from
 * listNodes().
 */
describe("retrieve — keyword fallback", () => {
  const key = process.env.AI_GATEWAY_API_KEY;
  beforeEach(() => { delete process.env.AI_GATEWAY_API_KEY; });
  afterEach(() => { if (key) process.env.AI_GATEWAY_API_KEY = key; });

  it("searches the caller's storage, not the demo-store map", async () => {
    const slug = `rag-fb-${Date.now()}`;
    createWorkspace({ name: "Rag fallback", slug });
    const demo = resolveDemoStorage(slug)!;
    await demo.createNode({ kind: "decision", title: "Webhooks vs polling", content_md: "## Decision\n\nWe chose webhooks because polling wastes quota.", parent_id: null });
    // A storage the demo-store map has never heard of.
    const foreign = new Proxy(demo, { get: (t, p) => (p === "backend" ? "supabase" : Reflect.get(t, p)) }) as unknown as Storage;
    const result = await retrieveScoped("no-such-slug-in-demo-store", "why webhooks polling", { k: 5, storage: foreign });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.title).toBe("Webhooks vs polling");
    expect(result.scope.keyword_fallback).toBe(true);
  });
});

/**
 * The evaluation needs the keyword scorer on demand, on a workspace that does
 * have embeddings. Forcing it must not so much as try the vector path — the
 * fallback logs when that path throws, and a forced run logs nothing.
 */
describe("retrieve — forced keyword path", () => {
  const key = process.env.AI_GATEWAY_API_KEY;
  const forced = process.env.RAG_FORCE_KEYWORD;
  beforeEach(() => { process.env.AI_GATEWAY_API_KEY = "test-key"; delete process.env.RAG_FORCE_KEYWORD; });
  afterEach(() => {
    if (key === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = key;
    if (forced === undefined) delete process.env.RAG_FORCE_KEYWORD; else process.env.RAG_FORCE_KEYWORD = forced;
  });

  async function seeded() {
    const slug = `rag-forced-${Date.now()}`;
    createWorkspace({ name: "Rag forced", slug });
    const demo = resolveDemoStorage(slug)!;
    await demo.createNode({ kind: "decision", title: "Webhooks vs polling", content_md: "## Decision\n\nWebhooks.", parent_id: null });
    return { slug, storage: demo as unknown as Storage };
  }

  it("answers from the keyword scorer without touching the vector path when asked per request", async () => {
    const { slug, storage } = await seeded();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await retrieveScoped(slug, "webhooks polling", { k: 3, storage, forceKeyword: true });
      expect(result.scope.keyword_fallback).toBe(true);
      expect(result.hits[0]!.title).toBe("Webhooks vs polling");
      expect(warn.mock.calls.some((c) => String(c[0]).includes("supabase retrieval failed"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("honours RAG_FORCE_KEYWORD=1 for the whole process", async () => {
    process.env.RAG_FORCE_KEYWORD = "1";
    expect(keywordForced()).toBe(true);
    expect(keywordForced({ forceKeyword: false })).toBe(true);
    delete process.env.RAG_FORCE_KEYWORD;
    expect(keywordForced()).toBe(false);
    expect(keywordForced({ forceKeyword: true })).toBe(true);
  });
});
