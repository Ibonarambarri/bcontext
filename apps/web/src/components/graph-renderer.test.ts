import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("immersive graph surface", () => {
  it("owns the full active surface and overlays one compact toolbar", () => {
    const renderer = readFileSync(new URL("./graph-renderer.tsx", import.meta.url), "utf8");
    // The graph surface moved out of view-canvas.tsx into its own component
    // when Brain gained the Tags focus (nav reorg 2026-09-08).
    const canvas = readFileSync(new URL("./graph-view.tsx", import.meta.url), "utf8");

    expect(renderer).toContain('className="h-full min-h-0"');
    expect(renderer).toContain("data-graph-toolbar");
    expect(renderer).toContain("data-graph-stage");
    expect(renderer).toContain('<GraphControl label="Fit graph"');
    expect(canvas).toContain("filterLabels(activeViewResult.applied_filters)");
    expect(canvas).not.toContain('h-[min(68vh,760px)]');
  });

  it("keeps local drag available even when a system view cannot persist layout", () => {
    const renderer = readFileSync(new URL("./graph-renderer.tsx", import.meta.url), "utf8");
    expect(renderer).toContain("onNodePositionChange?.(node, point)");
    expect(renderer).not.toContain("if (!onNodePositionChange || event.button !== 0) return");
  });

  it("renders an organic WebGL graph with curved edges and distinct tag actions", () => {
    const renderer = readFileSync(new URL("./graph-renderer.tsx", import.meta.url), "utf8");
    expect(renderer).toContain('import("sigma")');
    expect(renderer).toContain("new SigmaConstructor");
    expect(renderer).toContain("EdgeCurvedArrowProgram");
    expect(renderer).toContain("data-resource-type={resource.resource_type}");
    expect(renderer).toContain('data-tag-id={resource.resource_type === "tag" ? resource.tag.id : undefined}');
    expect(renderer).toContain("onSelectTag?.(resource.tag.id)");
    expect(renderer).toContain("foldGraphTags");
    expect(renderer).not.toContain('<option value="tag">Tag</option>');
  });

  it("settles the layout synchronously before the first painted frame — deterministic first load", () => {
    const renderer = readFileSync(new URL("./graph-renderer.tsx", import.meta.url), "utf8");
    // The engine's computed coordinates are authoritative seeds; the old
    // neighbor-centroid insertion heuristic (which broke the tags graph's
    // first paint) is gone, and layout runs synchronously — no worker, no
    // stabilization dance, no wrong-then-fixed first render.
    expect(renderer).toContain('import("graphology-layout-forceatlas2")');
    expect(renderer).not.toContain("graphology-layout-forceatlas2/worker");
    expect(renderer).toContain("settleLayout(graph, fa2, true, new Set(graph.nodes()), initial.hubNodeId != null)");
    // A hub snapshot already carries the engine's radial layout; ForceAtlas2
    // would drag every unpinned node out of it. Only overlaps are resolved.
    expect(renderer).toContain("if (hasHub) {");
    expect(renderer).toContain("relaxOverlaps(graph, full ? null : affectedIds);");
    expect(renderer).toContain("const seed = remembered ?? persistedToGraphPoint(persisted ?? { x: resource.x, y: resource.y })");
    expect(renderer).not.toContain("insertionPoint(");
    expect(renderer).not.toContain("settleTimer");
  });

  it("reconciles realtime snapshots without remounting the renderer or resetting the camera", () => {
    const renderer = readFileSync(new URL("./graph-renderer.tsx", import.meta.url), "utf8");
    const workspace = readFileSync(new URL("./workspace-context.tsx", import.meta.url), "utf8");

    expect(renderer).toContain("reconcileOrganicGraph(");
    expect(renderer).toContain("const sameEndpoints = edge.directed");
    expect(renderer).toContain("syncGraphRef.current = syncGraph");
    expect(renderer).toContain("runLayout(forceFull, changes.affectedIds)");
    expect(renderer).toContain("if (full) camera.setState");
    expect(workspace).toContain("const switchingView = resolvedViewIdRef.current !== activeView.id");
    expect(workspace).toContain("if (switchingView)");
  });

  it("colors by taxonomy community and resolves every hue from the live theme", () => {
    const renderer = readFileSync(new URL("./graph-renderer.tsx", import.meta.url), "utf8");
    // graphify's cluster-coloring, adapted: community fills, a community
    // legend, and a theme bridge so light and dark both render natively —
    // no hardcoded dark-only hex anywhere in the renderer.
    expect(renderer).toContain("assignGraphCommunities");
    expect(renderer).toContain("resolveResourceColor");
    expect(renderer).toContain("readGraphPalette");
    expect(renderer).toContain("watchGraphTheme");
    expect(renderer).toContain("edgeColorForLayer");
    expect(renderer).toContain("legendCommunities.map((community)");
    expect(renderer).not.toMatch(/GRAPH_INK|#cfcdc6|#4d4c48|#242421/);
  });

  it("limits focus noise and gives taxonomy more layout weight than cross-links", () => {
    const renderer = readFileSync(new URL("./graph-renderer.tsx", import.meta.url), "utf8");

    expect(renderer).toContain("taxonomy: 3.0");
    expect(renderer).toContain("references: 0.38");
    expect(renderer).toContain('label: edge.layer === "taxonomy" ? "" : rawLabel');
    expect(renderer).toContain("neighbors.slice(0, limit)");
    expect(renderer).toContain("focusBudgetForRatio(camera.getState().ratio)");
    expect(renderer).toContain("if (ratio <= 0.08) return 24");
    expect(renderer).toContain('label: showLabel ? scaled.label : "", forceLabel: false');
    expect(renderer).toContain("color: paletteRef.current.dimNode");
  });

  it("draws each kind's own lucide glyph inside the node, above a zoom floor", () => {
    const renderer = readFileSync(new URL("./graph-renderer.tsx", import.meta.url), "utf8");
    expect(renderer).toContain('import("@sigma/node-image")');
    expect(renderer).toContain("nodeProgramClasses: { pictogram: PictogramProgram }");
    // "background" keeps the tag-territory fill and puts the glyph over it.
    expect(renderer).toContain('drawingMode: "background"');
    expect(renderer).toContain("kindGlyphDataUri(glyphKey, readableInkOn(fill, palette))");
    // Unreadable at small rendered sizes, and never on a dimmed node.
    expect(renderer).toContain("GLYPH_MIN_RENDERED_SIZE");
    expect(renderer).toContain("type: undefined, image: undefined, color: paletteRef.current.dimNode");
  });

  it("names the territories, not the points", () => {
    const renderer = readFileSync(new URL("./graph-renderer.tsx", import.meta.url), "utf8");
    // A hundred sentence-long titles at once overlapped into a wall of text.
    // Only tags, the selection and folded groups carry a name now.
    expect(renderer).toContain("labelDensity: alwaysShowLabels ? 100 : 0");
    expect(renderer).toContain("forceLabel: resource.id === selectedNodeId || foldedCount > 0");
    expect(renderer).not.toContain("size >= 9.4");
  });

  it("paints content in its tag's colour and sits on the app background", () => {
    const renderer = readFileSync(new URL("./graph-renderer.tsx", import.meta.url), "utf8");
    // Tinting content toward the paper meant toward BLACK on the dark theme,
    // which sank every node into the background.
    expect(renderer).not.toContain("CONTENT_TINT");
    expect(renderer).toContain("return communityColor(community.hue, palette.isDark, isTag ? resource.depth : 1);");
    // The canvas is the same background as everything around it — no surface
    // tone, no vignette, no texture.
    expect(renderer).toContain('"relative h-full min-h-0 overflow-hidden bg-[var(--paper)]"');
    expect(renderer).not.toContain("radial-gradient");
  });

  it("bows cross-community links out of the middle of the disc", () => {
    const renderer = readFileSync(new URL("./graph-renderer.tsx", import.meta.url), "utf8");
    expect(renderer).toContain("CROSS_COMMUNITY_CURVATURE");
    expect(renderer).toContain("fromCommunity !== toCommunity");
  });
});
