import { describe, expect, it } from "vitest";
import type { GraphResourcePayload } from "@bcontext-dev/contract/graph/model";
import { NODE_KIND_ICONS } from "@/components/node-kind-icon";
import { KIND_GLYPH_BODIES } from "./kind-glyphs.generated";
import { glyphKeyForResource, kindGlyphDataUri } from "./kind-glyph";

function node(overrides: Partial<GraphResourcePayload> = {}): GraphResourcePayload {
  return {
    id: "n1",
    title: "Node",
    tags: [],
    depth: 1,
    x: 0.5,
    y: 0.5,
    resource_type: "node",
    kind: "doc",
    status: null,
    ...overrides,
  } as GraphResourcePayload;
}

describe("kind glyphs", () => {
  it("covers every node kind the lists can render", () => {
    // The point of the glyph is that the canvas and the lists share one
    // vocabulary; a kind with no glyph would silently fall back to a bare
    // circle and break that.
    for (const kind of Object.keys(NODE_KIND_ICONS)) {
      expect(KIND_GLYPH_BODIES, `no canvas glyph for kind "${kind}"`).toHaveProperty(kind);
    }
    expect(KIND_GLYPH_BODIES).toHaveProperty("tag");
  });

  it("builds an SVG data URI Sigma's texture loader can fetch", () => {
    const uri = kindGlyphDataUri("doc", "#123456");
    expect(uri.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    const svg = decodeURIComponent(uri.slice("data:image/svg+xml;utf8,".length));
    // Explicit dimensions: a data-URI SVG with no intrinsic size rasterizes
    // to nothing in some browsers.
    expect(svg).toContain('width="24"');
    expect(svg).toContain('height="24"');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('stroke="#123456"');
    // Some glyphs paint a detail with currentColor (the credential key's pin).
    expect(svg).toContain('color="#123456"');
  });

  it("returns the identical string for a repeated glyph — the atlas keys on it", () => {
    expect(kindGlyphDataUri("bug", "#abcdef")).toBe(kindGlyphDataUri("bug", "#abcdef"));
    expect(kindGlyphDataUri("bug", "#abcdef")).not.toBe(kindGlyphDataUri("bug", "#fedcba"));
  });

  it("gives a tag the hash glyph, matching the tag picker", () => {
    const tag = {
      id: "tag:1", title: "#area", tags: [], depth: 1, x: 0, y: 0,
      resource_type: "tag", kind: null, status: null,
      tag: { id: "1", name: "area", slug: "area", normalized_name: "area" },
      assignment_count: 3,
    } as unknown as GraphResourcePayload;
    expect(glyphKeyForResource(tag, null)).toBe("tag");
  });

  it("gives a content node its own kind", () => {
    expect(glyphKeyForResource(node({ kind: "decision" }), null)).toBe("decision");
  });

  it("leaves the landmarks bare — the hub carries its gradient, not a glyph", () => {
    expect(glyphKeyForResource(node({ id: "workspace:1" }), "workspace:1")).toBeNull();
  });
});
