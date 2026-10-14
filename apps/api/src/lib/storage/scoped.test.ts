import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  scopedStorage,
  ForbiddenError,
  CLASSIFIED_METHODS,
  filterToReach,
  filterToReachBy,
  NodeOutOfReachError,
} from "./scoped";
import { systemGrant, type Grant } from "@/lib/auth/grants";
import { ViewQuerySchema } from "@bcontext-dev/contract/views/schema";
import type { Storage } from "./index";

const WS = "ws-1";

const node = (id: string) => ({ id, title: id, kind: "doc" }) as never;

/** Minimal Storage double: enough surface to exercise every classification. */
function fakeStorage(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const track =
    <T>(name: string, result: T) =>
    async (...args: unknown[]) => {
      calls.push(`${name}(${args.length})`);
      return result;
    };

  const base = {
    backend: "supabase" as const,
    workspace: { id: WS, slug: "ws", name: "WS" },
    // listNodes sirve dos propósitos: la lectura del llamante y la resolución
    // del reach (una llamada de conteo sin tags, otra por predicado de tags).
    // Distinguirlas por los args mantiene los tests legibles y no frágiles al
    // orden de las llamadas.
    listNodes: async (opts?: { tagSlugs?: string[] }) => {
      calls.push(opts?.tagSlugs ? `listNodes(tags)` : "listNodes(plain)");
      return opts?.tagSlugs ? [node("in")] : [node("in"), node("out")];
    },
    // listNodeSummaries now serves both the ceiling probe (no tag refs) and the
    // reach resolution itself (tag refs), which is the cheap query — it was
    // pulling full markdown for the whole workspace before.
    listNodeSummaries: async (opts?: { tagIds?: string[]; tagSlugs?: string[] }) => {
      calls.push("listNodeSummaries");
      const filtered = (opts?.tagIds?.length ?? 0) + (opts?.tagSlugs?.length ?? 0) > 0;
      return filtered ? [node("in")] : [node("in"), node("out")];
    },
    listNodeContext: track("listNodeContext", [node("out")]),
    getNode: track("getNode", node("out")),
    countTagUsage: track("countTagUsage", new Map()),
    listTags: track("listTags", []),
    getTag: track("getTag", null),
    resolveTagIds: track("resolveTagIds", new Map()),
    listTagRelations: track("listTagRelations", []),
    listEdges: track("listEdges", []),
    createNode: track("createNode", node("new")),
    updateNode: track("updateNode", node("upd")),
    deleteNode: track("deleteNode", true),
    setNodeTags: track("setNodeTags", node("t")),
    createEdge: track("createEdge", {}),
    deleteEdge: track("deleteEdge", true),
    createTag: track("createTag", {}),
    updateTag: track("updateTag", {}),
    mergeTags: track("mergeTags", {}),
    deleteTag: track("deleteTag", true),
    createTagRelations: track("createTagRelations", []),
    deleteTagRelation: track("deleteTagRelation", true),
    ...overrides,
  };
  return { storage: base as unknown as Storage, calls };
}

const grantWith = (verbs: string[], reach: Grant["reach"] = { type: "all" }): Grant => ({
  workspaceId: WS,
  principal: { kind: "user", id: "u1" },
  verbs: verbs as Grant["verbs"],
  reach,
});

const financeReach: Grant["reach"] = {
  type: "query",
  query: ViewQuerySchema.parse({ schema_version: 1, tags_any: ["finanzas"] }),
};

describe("every Storage method is classified", () => {
  it("leaves nothing unclassified — the guard against a silently unfiltered 23rd method", () => {
    // Read the real interface, not the double above. Checking the double would
    // only prove that this file agrees with itself: a method added to `Storage`
    // and forgotten here would pass, which is exactly the case worth catching.
    // TypeScript interfaces leave no runtime trace, so parse the source.
    const src = readFileSync(join(process.cwd(), "src/lib/storage/index.ts"), "utf8");
    const body = src.slice(
      src.indexOf("export interface Storage {"),
      src.indexOf("\n}", src.indexOf("export interface Storage {")),
    );
    const declared = [...body.matchAll(/^\s{2}([a-zA-Z][\w]*)\s*\(/gm)]
      .map((m) => m[1])
      .filter((name): name is string => Boolean(name));

    expect(declared.length, "failed to parse the Storage interface").toBeGreaterThan(15);
    const missing = declared.filter((m) => !CLASSIFIED_METHODS.includes(m));
    expect(
      missing,
      `Unclassified Storage methods. Decide in src/lib/storage/scoped.ts whether ` +
        `each needs reach filtering, a verb, or neither.\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("throws rather than passing an unknown method through unfiltered", () => {
    const { storage } = fakeStorage({ someNewReadIAdded: async () => ["secret"] });
    const scoped = scopedStorage(storage, systemGrant(WS, "test"));
    expect(() => (scoped as unknown as Record<string, unknown>).someNewReadIAdded).toThrow(
      /not classified/,
    );
  });
});

describe("reach narrows node reads", () => {
  it("filters list results down to the reach", async () => {
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read"], financeReach));
    const rows = (await scoped.listNodes()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["in"]);
  });

  it("reads an out-of-reach node as absent, not as denied", async () => {
    // Returning 403 would confirm the node exists — the same leak the route
    // fixes closed.
    const { storage } = fakeStorage({ getNode: async () => node("out") });
    const scoped = scopedStorage(storage, grantWith(["read"], financeReach));
    expect(await scoped.getNode("out")).toBeNull();
  });

  it("returns an in-reach node normally", async () => {
    const { storage } = fakeStorage({ getNode: async () => node("in") });
    const scoped = scopedStorage(storage, grantWith(["read"], financeReach));
    expect(await scoped.getNode("in")).not.toBeNull();
  });

  it("does not filter when the reach is unrestricted", async () => {
    const { storage, calls } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read"]));
    const rows = (await scoped.listNodes()) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
    // No extra listNodes call: an unrestricted reach costs nothing to resolve.
    expect(calls.filter((c) => c.startsWith("listNodes"))).toHaveLength(1);
  });

  it("matches nothing when a query reach carries no tag filter", async () => {
    // The deny sentinel's shape, and the safe reading of an empty filter.
    const empty: Grant["reach"] = {
      type: "query",
      query: ViewQuerySchema.parse({ schema_version: 1 }),
    };
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read"], empty));
    expect(await scoped.listNodes()).toEqual([]);
  });

  it("refuses a reach it cannot compute rather than applying a truncated one", async () => {
    // The ceiling has to be checked on the unfiltered count: listNodes truncates
    // to 5000 raw rows *before* applying tags, so a filtered result would come
    // back under the ceiling and hide the truncation.
    const { storage } = fakeStorage({
      listNodeSummaries: async () => Array.from({ length: 5000 }, (_, i) => node(`n${i}`)),
    });
    const scoped = scopedStorage(storage, grantWith(["read"], financeReach));
    await expect(scoped.listNodes()).rejects.toThrow(/truncated/);
  });

  it("resolves the reach once and reuses it across reads", async () => {
    const listNodeSummaries = vi.fn().mockResolvedValue([node("in")]);
    const { storage } = fakeStorage({ listNodeSummaries, getNode: async () => node("in") });
    const scoped = scopedStorage(storage, grantWith(["read"], financeReach));
    await scoped.getNode("in");
    await scoped.getNode("in");
    await scoped.getNode("in");
    // Two summary queries for the whole wrapper (ceiling probe + tag lookup),
    // not two per read.
    expect(listNodeSummaries).toHaveBeenCalledTimes(2);
  });
});

describe("verbs gate mutations", () => {
  it("rejects a write without the verb", async () => {
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read"]));
    await expect(scoped.createNode({} as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("allows a write with the verb", async () => {
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read", "write"]));
    await expect(scoped.createNode({} as never)).resolves.toBeTruthy();
  });

  it("requires delete for deleteNode, not write", async () => {
    const { storage } = fakeStorage();
    const writer = scopedStorage(storage, grantWith(["read", "write"]));
    await expect(writer.deleteNode("x")).rejects.toBeInstanceOf(ForbiddenError);
    const deleter = scopedStorage(storage, grantWith(["read", "write", "delete"]));
    await expect(deleter.deleteNode("x")).resolves.toBe(true);
  });

  it("treats mergeTags as destructive: tags:update is not enough", async () => {
    // Merging rewrites the classification of everything that hung off the
    // absorbed tag — and, once reaches are tag-expressed, other principals'
    // reaches along with it.
    const { storage } = fakeStorage();
    const updater = scopedStorage(storage, grantWith(["read", "tags:update"]));
    await expect(updater.mergeTags("a", "b")).rejects.toBeInstanceOf(ForbiddenError);
    const deleter = scopedStorage(storage, grantWith(["read", "tags:delete"]));
    await expect(deleter.mergeTags("a", "b")).resolves.toBeTruthy();
  });

  it("rejects reads without the read verb", async () => {
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["write"]));
    await expect(scoped.listTags()).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("passthrough", () => {
  it("exposes workspace and backend unchanged", () => {
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read"]));
    expect(scoped.backend).toBe("supabase");
    expect(scoped.workspace.id).toBe(WS);
  });
});

describe("filterToReach — for callers that bypass the methods", () => {
  it("narrows rows handed to it by a scoped storage", async () => {
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read"], financeReach));
    const rows = await filterToReach(scoped, [{ id: "in" }, { id: "out" }]);
    expect(rows.map((r) => r.id)).toEqual(["in"]);
  });

  it("passes everything through for an unscoped system storage", async () => {
    const { storage } = fakeStorage();
    const rows = await filterToReach(storage, [{ id: "a" }, { id: "b" }]);
    expect(rows).toHaveLength(2);
  });

  it("gives two principals different views of the same shared cache", async () => {
    // The cross-request workspace index is keyed by workspace alone, on purpose.
    // What keeps that from leaking is narrowing on the way out, per principal —
    // not a per-principal cache key, which would destroy the sharing.
    const cachedIndex = [{ id: "fin-1" }, { id: "eng-1" }];
    const finance = scopedStorage(
      fakeStorage({
        listNodeSummaries: async (opts?: { tagSlugs?: string[] }) =>
          opts?.tagSlugs?.length ? [node("fin-1")] : [node("fin-1"), node("eng-1")],
      }).storage,
      grantWith(["read"], financeReach),
    );
    const everything = scopedStorage(fakeStorage().storage, grantWith(["read"]));

    expect((await filterToReach(finance, cachedIndex)).map((r) => r.id)).toEqual(["fin-1"]);
    expect(await filterToReach(everything, cachedIndex)).toHaveLength(2);
  });
});

describe("reach binds writes, not just reads", () => {
  // The version before this one checked verbs on mutations and called straight
  // through: a principal narrowed to finanzas could not *read* outside its
  // reach but could delete anything in the workspace. Worse, the deny sentinel
  // denied every read while leaving every write unrestricted.
  const narrowed = (verbs: string[]) => {
    const { storage } = fakeStorage();
    return scopedStorage(storage, grantWith(verbs, financeReach));
  };

  it("refuses to update a node outside the reach", async () => {
    await expect(narrowed(["read", "write"]).updateNode("out", {} as never)).rejects.toThrow(
      NodeOutOfReachError,
    );
  });

  it("refuses to delete a node outside the reach", async () => {
    await expect(narrowed(["read", "delete"]).deleteNode("out")).rejects.toThrow(
      NodeOutOfReachError,
    );
  });

  it("refuses to retag a node outside the reach", async () => {
    await expect(narrowed(["read", "write"]).setNodeTags("out", [])).rejects.toThrow(
      NodeOutOfReachError,
    );
  });

  it("allows the same mutations inside the reach", async () => {
    await expect(narrowed(["read", "write"]).updateNode("in", {} as never)).resolves.toBeTruthy();
  });

  it("reports an out-of-reach mutation as missing, not as forbidden", async () => {
    // Same reason as reads: a 403 confirms the node exists.
    const err = await narrowed(["read", "delete"])
      .deleteNode("out")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(NodeOutOfReachError);
    expect((err as Error).message).toMatch(/not found/);
  });

  it("requires both edge endpoints to be in reach", async () => {
    const scoped = narrowed(["read", "write"]);
    await expect(
      scoped.createEdge({ from_node: "in", to_node: "out", relation: "references" } as never),
    ).rejects.toThrow(NodeOutOfReachError);
    await expect(
      scoped.createEdge({ from_node: "in", to_node: "in", relation: "references" } as never),
    ).resolves.toBeTruthy();
  });
});

describe("edges do not leak the shape of the graph", () => {
  it("drops edges with an endpoint outside the reach", async () => {
    // An edge with one endpoint outside still discloses that node's id and how
    // it relates to something visible — enough to map the tenant's graph.
    const { storage } = fakeStorage({
      listEdges: async () => [
        { from_node: "in", to_node: "in", relation: "references" },
        { from_node: "in", to_node: "out", relation: "blocked_by" },
      ],
    });
    const scoped = scopedStorage(storage, grantWith(["read"], financeReach));
    const edges = await scoped.listEdges();
    expect(edges).toHaveLength(1);
  });
});

describe("the limit is honoured after filtering, not before", () => {
  it("does not return an empty page when reachable nodes sort late", async () => {
    // Filtering after the inner limit means a principal asking for 1 gets 0 and
    // cannot page further — indistinguishable from having no nodes at all.
    const { storage } = fakeStorage({
      listNodeSummaries: async (opts?: { tagSlugs?: string[] }) =>
        opts?.tagSlugs?.length ? [node("late")] : [node("early-1"), node("early-2"), node("late")],
      listNodes: async () => [node("early-1"), node("early-2"), node("late")],
    });
    const scoped = scopedStorage(storage, grantWith(["read"], financeReach));
    const rows = (await scoped.listNodes({ limit: 1 })) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["late"]);
  });
});

describe("Object.prototype plumbing passes through", () => {
  it("can be interpolated and inspected without throwing", () => {
    // Throwing on toString turns a console.log or a template literal into a
    // 500, usually inside an error path where it masks the real failure.
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read"]));
    expect(() => `${scoped}`).not.toThrow();
    expect(() => scoped.constructor).not.toThrow();
    expect(() => Object.prototype.hasOwnProperty.call(scoped, "listNodes")).not.toThrow();
  });
});

describe("filterToReachBy — rows about a node that are not nodes", () => {
  const entries = [
    { id: "act-1", node_id: "in" },
    { id: "act-2", node_id: "out" },
    { id: "act-3", node_id: null }, // a workspace-level event
  ];

  it("drops entries about out-of-reach nodes, keeps node-less ones", async () => {
    // The change feed carries full before/after markdown in its payload, so an
    // entry about an unreachable node is a way to read around the reach.
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read"], financeReach));
    const kept = await filterToReachBy(scoped, entries, (e) => e.node_id);
    expect(kept.map((e) => e.id)).toEqual(["act-1", "act-3"]);
  });

  it("drops entries about nodes that no longer exist", async () => {
    // A deleted node has no tags left to test, so it cannot be shown to be in
    // reach — and showing it anyway leaks the content the reach was hiding.
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read"], financeReach));
    const kept = await filterToReachBy(scoped, [{ id: "a", node_id: "deleted" }], (e) => e.node_id);
    expect(kept).toEqual([]);
  });

  it("leaves everything alone for an unrestricted principal", async () => {
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read"]));
    expect(await filterToReachBy(scoped, entries, (e) => e.node_id)).toHaveLength(3);
  });
});

describe("methods whose first argument is not an options object", () => {
  it("filters listNodeContext without mangling its arguments", async () => {
    // listNodeContext(id, limit) is positional. Treating args[0] as options and
    // spreading it turns the node id string into {0:'a',1:'b',…} and sends an
    // object where the RPC expects a uuid — a 500 for every narrowed principal.
    let received: unknown[] = [];
    const { storage } = fakeStorage({
      listNodeContext: async (...args: unknown[]) => {
        received = args;
        return [node("in"), node("out")];
      },
    });
    const scoped = scopedStorage(storage, grantWith(["read"], financeReach));
    const rows = (await scoped.listNodeContext("node-a", 10)) as Array<{ id: string }>;
    expect(received).toEqual(["node-a", 10]);
    expect(rows.map((r) => r.id)).toEqual(["in"]);
  });
});

describe("protocol members do not throw", () => {
  it("can be returned from an async function", async () => {
    // The promise resolution procedure reads `.then` off any resolved value, so
    // throwing here makes `async () => scopedStorage(…)` reject — and
    // getStorage() is already async, which is exactly how this will be wired.
    const { storage } = fakeStorage();
    const build = async () => scopedStorage(storage, grantWith(["read"]));
    await expect(build()).resolves.toBeDefined();
  });

  it("survives JSON.stringify", () => {
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read"]));
    expect(() => JSON.stringify({ storage: scoped })).not.toThrow();
  });
});

describe("parent_id is reach-checked like an edge endpoint", () => {
  it("refuses to create a node under an out-of-reach parent", async () => {
    // Creating under an out-of-reach parent mutates that node's subtree, and the
    // error distinguishes "exists here" from "does not".
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read", "write"], financeReach));
    await expect(scoped.createNode({ parent_id: "out" } as never)).rejects.toThrow(
      NodeOutOfReachError,
    );
  });

  it("refuses to reparent an in-reach node under an out-of-reach one", async () => {
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read", "write"], financeReach));
    await expect(
      scoped.updateNode("in", { parent_id: "out" } as never),
    ).rejects.toThrow(NodeOutOfReachError);
  });

  it("allows a parent inside the reach", async () => {
    const { storage } = fakeStorage();
    const scoped = scopedStorage(storage, grantWith(["read", "write"], financeReach));
    await expect(scoped.createNode({ parent_id: "in" } as never)).resolves.toBeTruthy();
    await expect(scoped.createNode({} as never)).resolves.toBeTruthy();
  });
});

describe("a reach written with tag ids works", () => {
  it("resolves uuid tag refs as ids, not as slugs", async () => {
    // The natural shape of a grant: `list_tags` returns ids and every other tag
    // API takes them. Passing a uuid as a slug matches nothing at all —
    // silently, with no error — so the principal would see zero nodes and the
    // grant model would be unusable in its most obvious form.
    let received: { tagIds?: string[]; tagSlugs?: string[] } = {};
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const { storage } = fakeStorage({
      listNodeSummaries: async (opts?: { tagIds?: string[]; tagSlugs?: string[] }) => {
        if ((opts?.tagIds?.length ?? 0) + (opts?.tagSlugs?.length ?? 0) > 0) received = opts!;
        return [node("in")];
      },
    });
    const reach: Grant["reach"] = {
      type: "query",
      query: ViewQuerySchema.parse({ schema_version: 1, tags_any: [uuid, "finanzas"] }),
    };
    const scoped = scopedStorage(storage, grantWith(["read"], reach));
    await scoped.getNode("in");
    expect(received.tagIds).toEqual([uuid]);
    expect(received.tagSlugs).toEqual(["finanzas"]);
  });
});

describe("deleting cannot destroy what the principal cannot see", () => {
  it("refuses to delete a node with out-of-reach descendants", async () => {
    // The database cascade removes children silently, so checking only the named
    // node would let a finanzas-scoped principal delete a finanzas parent and
    // take out children it can neither see nor name.
    const { storage } = fakeStorage({
      listNodeSummaries: async (opts?: { tagSlugs?: string[] }) =>
        opts?.tagSlugs?.length
          ? [{ id: "in", parent_id: null }]
          : [
              { id: "in", parent_id: null },
              { id: "hidden-child", parent_id: "in" },
            ],
    });
    const scoped = scopedStorage(storage, grantWith(["read", "delete"], financeReach));
    await expect(scoped.deleteNode("in")).rejects.toThrow(NodeOutOfReachError);
  });
});

describe("non-function properties are classified too", () => {
  it("refuses to hand out the underlying supabase client", () => {
    // SupabaseStorage holds a service-role client. Handing it out would bypass
    // every check in this module with a single property access.
    const { storage } = fakeStorage({ client: { from: () => ({}) } });
    const scoped = scopedStorage(storage, grantWith(["read"], financeReach));
    expect(() => (scoped as unknown as Record<string, unknown>).client).toThrow(
      /not classified/,
    );
  });
});

describe("credential values never leave the door unmasked", () => {
  const credential = {
    id: "cred-1",
    title: "Stripe — API keys",
    kind: "credential",
    data: {
      credential: { schema_version: 1, type: "api_key", environment: "prod", service: "Stripe" },
      fields: [{ key: "api_key", name: "API key", value: "sk_live_REAL", secret: true }],
    },
  } as never;

  function storageWith() {
    return fakeStorage({
      getNode: async () => credential,
      listNodeContext: async () => [credential],
      listNodes: async () => [credential],
      listNodeSummaries: async () => [credential],
    });
  }

  it("masks getNode, listNodes, listNodeSummaries and listNodeContext when asked", async () => {
    const { storage } = storageWith();
    const scoped = scopedStorage(storage, grantWith(["read"]), { maskCredentials: true });
    const reads = [
      await scoped.getNode("cred-1"),
      (await scoped.listNodes({}))[0],
      (await scoped.listNodeSummaries({}))[0],
      (await scoped.listNodeContext("cred-1", 10))[0],
    ];
    for (const read of reads) {
      expect(JSON.stringify(read)).not.toContain("sk_live_REAL");
      expect((read as unknown as { data: { fields: Array<{ value: string }> } }).data.fields[0]?.value).toBe("[redacted]");
      // The shape survives: an agent still knows which credential this is.
      expect((read as unknown as { data: { credential: { environment: string } } }).data.credential.environment).toBe("prod");
    }
  });

  it("leaves the value alone for a principal that may see it", async () => {
    const { storage } = storageWith();
    const scoped = scopedStorage(storage, grantWith(["read"]));
    const read = (await scoped.getNode("cred-1")) as unknown as { data: { fields: Array<{ value: string }> } };
    expect(read.data.fields[0]?.value).toBe("sk_live_REAL");
  });

  it("leaves every other kind untouched", async () => {
    const { storage } = storageWith();
    const doc = { id: "d1", kind: "doc", data: { fields: [{ name: "x", value: "keep" }] } } as never;
    const scoped = scopedStorage(fakeStorage({ getNode: async () => doc }).storage, grantWith(["read"]), {
      maskCredentials: true,
    });
    expect(JSON.stringify(await scoped.getNode("d1"))).toContain("keep");
    void storage;
  });
});

describe("goals that steer the company need goals:write", () => {
  const goal = (id: string, data: Record<string, unknown>, parent_id: string | null = null) =>
    ({ id, title: id, kind: "goal", parent_id, data }) as never;

  const northStar = goal("ns", { root: true, scope: "company" });
  const company = goal("company-1", { scope: "company" }, "ns");
  const project = goal("project-1", { scope: "project" }, "company-1");
  const doc = { id: "doc-1", title: "doc", kind: "doc", parent_id: null, data: {} } as never;

  /** A workspace where every goal above exists, addressed by id. */
  function workspace(overrides: Partial<Record<string, unknown>> = {}) {
    const all = [northStar, company, project, doc];
    return fakeStorage({
      getNode: async (id: string) => all.find((n) => (n as { id: string }).id === id) ?? null,
      listNodes: async () => all,
      listNodeSummaries: async () => all,
      ...overrides,
    });
  }

  const editor = grantWith(["read", "write", "delete"]);
  const lead = grantWith(["read", "write", "delete", "goals:write"]);

  it("refuses an editor the North Star and every company goal", async () => {
    const scoped = scopedStorage(workspace().storage, editor);
    await expect(scoped.updateNode("ns", { title: "New north star" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(scoped.updateNode("company-1", { status: "at_risk" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(scoped.deleteNode("company-1")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(scoped.setNodeTags("ns", ["t1"])).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("names the verb it is missing, so the agent can ask for it", async () => {
    const scoped = scopedStorage(workspace().storage, editor);
    await expect(scoped.updateNode("ns", { title: "x" })).rejects.toMatchObject({ verb: "goals:write" });
  });

  it("lets the same editor work on a project goal", async () => {
    const { storage, calls } = workspace();
    const scoped = scopedStorage(storage, editor);
    await scoped.updateNode("project-1", { status: "on_track" });
    await scoped.deleteNode("project-1");
    expect(calls).toContain("updateNode(2)");
    expect(calls).toContain("deleteNode(1)");
  });

  it("refuses a patch that would promote a project goal to the company", async () => {
    const scoped = scopedStorage(workspace().storage, editor);
    await expect(
      scoped.updateNode("project-1", { data: { scope: "company" } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      scoped.updateNode("project-1", { data: { root: true } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a delete whose cascade would take a company goal with it", async () => {
    // The named node is an ordinary doc; the company goal hangs underneath it,
    // and the database would remove it silently.
    const orphaned = goal("company-2", { scope: "company" }, "doc-1");
    const { storage } = fakeStorage({
      getNode: async (id: string) => (id === "doc-1" ? doc : orphaned),
      listNodes: async () => [doc, orphaned],
      listNodeSummaries: async () => [doc, orphaned],
    });
    await expect(scopedStorage(storage, editor).deleteNode("doc-1")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creates a project goal on `write` alone and refuses every other shape", async () => {
    const { storage } = workspace();
    const scoped = scopedStorage(storage, editor);
    await scoped.createNode({ title: "Ship it", kind: "goal", parent_id: null, data: { scope: "project" } });
    // No scope at all is not evidence of a project goal: creation would infer
    // `company` for a parentless one, so it fails closed.
    await expect(
      scoped.createNode({ title: "?", kind: "goal", parent_id: null }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      scoped.createNode({ title: "?", kind: "goal", parent_id: null, data: { scope: "company" } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      scoped.createNode({ title: "?", kind: "goal", parent_id: null, data: { root: true, scope: "project" } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("leaves every other kind under the ordinary write verb", async () => {
    const { storage, calls } = workspace();
    const scoped = scopedStorage(storage, editor);
    await scoped.createNode({ title: "Notes", kind: "doc", parent_id: null });
    await scoped.updateNode("doc-1", { title: "Notes" });
    expect(calls.filter((c) => c.startsWith("createNode")).length).toBe(1);
    expect(calls).toContain("updateNode(2)");
  });

  it("lets a principal holding the verb through, without reading the node first", async () => {
    const { storage, calls } = workspace();
    const scoped = scopedStorage(storage, lead);
    await scoped.updateNode("ns", { title: "New north star" });
    await scoped.createNode({ title: "Double revenue", kind: "goal", parent_id: null, data: { scope: "company" } });
    expect(calls).not.toContain("getNode(1)");
  });
});
