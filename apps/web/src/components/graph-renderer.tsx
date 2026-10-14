"use client";

/**
 * The 2D knowledge graph: a `GraphSnapshot` from the contract drawn with
 * sigma (WebGL) over a graphology graph. Mounted by `graph-view.tsx` for
 * both focuses of the Brain view (knowledge and tags); `compact` is the
 * small framing other surfaces can embed.
 *
 * How the pieces fit:
 *   · `presentation` (memo) is the snapshot after depth, layer toggles and
 *     tag folds — the ONLY thing the canvas ever draws. Communities and
 *     sizes derive from it (`src/lib/graph/*`).
 *   · The sigma renderer is created once per mount in the big effect keyed
 *     on `[compact, alwaysShowLabels]`: sigma and ForceAtlas2 are imported
 *     lazily there, the graphology graph is filled by `reconcileOrganicGraph`,
 *     the layout settles SYNCHRONOUSLY (`settleLayout`) before the first
 *     frame, and every camera/mouse handler is bound. The cleanup kills the
 *     renderer and remembers where nodes settled so a remount does not
 *     reshuffle them.
 *   · Everything React learns afterwards (new presentation, positions,
 *     selection, callbacks) goes through `liveGraphRef`, and a second effect
 *     calls `syncGraph` to reconcile in place — a partial settle for
 *     topology changes, a full one only when `layoutNonce` moves
 *     (Auto-arrange). Node/edge reducers read refs (`hoveredRef`,
 *     `focusNodeLabelsRef`, `cameraRatioRef`) so a hover never rebuilds the
 *     graph.
 *   · Theme flips restyle colours in place (`palette` effect); positions
 *     and camera never move for a theme.
 *   · Below the component: camera flight, colour resolution, the two
 *     layout regimes, the sigma attribute builders and the focus budget.
 *
 * The sr-only button list under the canvas is the keyboard/AT surface: one
 * focusable per visible resource, arrow keys hop by geometry.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Graph from "graphology";
import type Sigma from "sigma";
import type { EdgeProgramType, NodeProgramType } from "sigma/rendering";
import {
  ExternalLink,
  GitBranch,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  Tags,
  X,
} from "lucide-react";
import { Button, Card, Chip, ToggleButton, Tooltip } from "@heroui/react";
import { isTerminalStatus } from "@bcontext-dev/contract/types";
import { cn } from "@bcontext-dev/contract/utils";
import {
  describeNodeConnections,
  nextGraphNodeId,
  type GraphEdgePayload,
  type GraphLayer,
  type GraphResourcePayload,
  type GraphSnapshot,
} from "@bcontext-dev/contract/graph/model";
import {
  filterVisibleGraphLayer,
  foldGraphTags,
  graphNodeSizes,
} from "@/lib/graph/presentation";
import {
  assignGraphCommunities,
  communityColor,
  UNTAGGED_COMMUNITY,
  type GraphCommunity,
} from "@/lib/graph/communities";
import {
  mixColors,
  readGraphPalette,
  readableInkOn,
  watchGraphTheme,
  type GraphPalette,
} from "@/lib/graph/theme";
import { glyphKeyForResource, kindGlyphDataUri } from "@/lib/graph/kind-glyph";
import {
  packDisconnectedComponents,
  relaxNodeOverlaps,
  type OverlapRelaxationNode,
} from "@/lib/graph/organic-layout";

type FA2Module = (typeof import("graphology-layout-forceatlas2"))["default"];

const LAYER_LABELS: Record<GraphLayer, string> = {
  hierarchy: "Hierarchy",
  taxonomy: "Tags",
  references: "References",
  dependencies: "Dependencies",
  semantic: "Semantic",
};

/**
 * The graph opens on its SKELETON. hierarchy + taxonomy are the two layers
 * that describe where a node belongs (parent chains, tag membership); they
 * form a tree, so the first thing the user sees has no crossings at all.
 * references/dependencies/semantic are cross-links: every one of them is a
 * chord across the disc, and with all of them on by default the structure
 * disappeared under them. They stay one click away in the toolbar.
 */
const STRUCTURAL_LAYERS: readonly GraphLayer[] = ["hierarchy", "taxonomy"];

/**
 * Layout attraction per layer (graphify keeps one spring constant because
 * its edges are homogeneous; ours are typed). Taxonomy pulls members toward
 * their tag anchor, hierarchy keeps parent chains tight, cross-links stay
 * loose so they don't fold distinct areas onto each other.
 */
const LAYOUT_EDGE_WEIGHTS: Record<GraphLayer, number> = {
  taxonomy: 3.0,
  hierarchy: 1.25,
  dependencies: 0.7,
  references: 0.38,
  semantic: 0.22,
};

/** Edge stroke = paper→ink blend per layer, resolved from the live theme. */
const EDGE_INK_MIX: Record<GraphLayer, number> = {
  taxonomy: 0.14,
  hierarchy: 0.30,
  references: 0.22,
  dependencies: 0.38,
  semantic: 0.11,
};

/**
 * Below this RENDERED radius a 24px glyph is mush, so the node stays the plain
 * circle it is today and the glyph appears as the camera comes in — the same
 * progressive disclosure the labels already use. Tuned against the label
 * budget (`labelRenderedSizeThreshold: 8.2`) rather than by eye; worth a look
 * on a real workspace graph.
 */
const GLYPH_MIN_RENDERED_SIZE = 11;

type SigmaNodeAttributes = {
  x: number;
  y: number;
  size: number;
  label: string;
  color: string;
  resource: GraphResourcePayload;
  community: string;
  /** Data URI of the kind glyph, or undefined for the hub and clusters. */
  image?: string;
  /** Sigma program key: "pictogram" when this node carries a glyph. */
  type?: string;
  fixed: boolean;
  forceLabel: boolean;
  zIndex: number;
};

type SigmaEdgeAttributes = {
  label: string;
  color: string;
  size: number;
  type: "curved" | "curvedArrow";
  curvature: number;
  forceLabel: boolean;
  layer: GraphLayer;
};

type OrganicGraph = Graph<SigmaNodeAttributes, SigmaEdgeAttributes>;

/**
 * See the file header for the lifecycle. `title` stays in the props contract
 * for callers/semantics, but the visible title itself lives in the shell's
 * content header — it is not rendered here.
 */
export function GraphRenderer({
  filters = [],
  snapshot,
  selectedNodeId,
  onSelect,
  onSelectTag,
  compact = false,
  foldedTagIds = [],
  alwaysShowLabels = false,
  onFoldedTagsChange,
  onNodePositionChange,
  onResetNodePositions,
  onHoverResource,
  flyToSelection = false,
  focusAnchorX = 0.5,
}: {
  title?: string;
  filters?: string[];
  snapshot: GraphSnapshot;
  selectedNodeId?: string | null;
  onSelect?: (nodeId: string) => void;
  onSelectTag?: (tagId: string) => void;
  compact?: boolean;
  foldedTagIds?: string[];
  /**
   * Force every node label to render regardless of zoom/density budgets.
   * Meant for small, fully-labelable graphs (the tags graph); the knowledge
   * graph keeps the default density-based labeling — leave it off there.
   */
  alwaysShowLabels?: boolean;
  onFoldedTagsChange?: (tagIds: string[]) => void;
  onNodePositionChange?: (resourceId: string, point: { x: number; y: number }) => void;
  onResetNodePositions?: () => void;
  /**
   * Pointer hover over a rendered resource, with stage-relative pixel
   * coordinates of the node center — e.g. to anchor an external HoverCard.
   * Always emits `null` on leave, pan/zoom, drag start, re-layout and
   * teardown, so consumers never hold a stale anchor.
   */
  onHoverResource?: (hover: { resource: GraphResourcePayload; x: number; y: number } | null) => void;
  /**
   * Fly the camera to `selectedNodeId` whenever it changes (the knowledge
   * graph does; the compact context lens and the tags graph keep their
   * framing).
   */
  flyToSelection?: boolean;
  /**
   * Where (0..1 of the stage width) the selected node is centered when the
   * camera flies to it — 0.5 normally, 0.25 while the floating node panel
   * covers the right half so the node sits in the middle of the free half.
   */
  focusAnchorX?: number;
}) {
  const [depth, setDepth] = useState(snapshot.depth);
  const [layers, setLayers] = useState<Set<GraphLayer>>(() => {
    const structural = snapshot.enabled_layers.filter((layer) => STRUCTURAL_LAYERS.includes(layer));
    return new Set(structural.length > 0 ? structural : snapshot.enabled_layers);
  });
  const [foldedTags, setFoldedTags] = useState<Set<string>>(() => new Set(foldedTagIds));
  const [activeTagId, setActiveTagId] = useState<string | null>(null);
  const [focusedResourceId, setFocusedResourceId] = useState<string | null>(selectedNodeId ?? snapshot.center_node_id);
  const [hoveredResourceId, setHoveredResourceId] = useState<string | null>(null);
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>(snapshot.pinned_positions);
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [palette, setPalette] = useState<GraphPalette>(() => readGraphPalette(null));
  const [rendererReady, setRendererReady] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const syncGraphRef = useRef<(() => void) | null>(null);
  const settledPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const lastLaidOutNonceRef = useRef(-1);
  const hoveredRef = useRef<string | null>(null);
  const focusedRef = useRef<string | null>(focusedResourceId);
  const selectedRef = useRef<string | null>(selectedNodeId ?? null);
  // The node reducer needs the live zoom, and it is installed before the
  // renderer exists — so the camera writes it here instead.
  const cameraRatioRef = useRef(1);
  const focusNodeLabelsRef = useRef(new Set<string>());
  const focusEdgesRef = useRef(new Set<string>());
  const keyboardRefs = useRef(new Map<string, HTMLButtonElement>());
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  // Theme bridge: resolve the HeroUI tokens into WebGL-safe colors at mount
  // and again on every light/dark flip — the graph is native in both themes.
  useEffect(() => {
    const read = () => setPalette(readGraphPalette(stageRef.current));
    read();
    return watchGraphTheme(read);
  }, []);

  const presentation = useMemo(() => {
    const depthNodes = snapshot.nodes.filter((node) => snapshot.mode !== "centered" || node.depth <= depth);
    const ids = new Set(depthNodes.map((node) => node.id));
    const sourceEdges = snapshot.edges.filter((edge) =>
      ids.has(edge.from) && ids.has(edge.to) && (edge.layer === "taxonomy" || layers.has(edge.layer)),
    );
    const folded = foldGraphTags(depthNodes, sourceEdges, foldedTags);
    const { nodes: visibleNodes, edges: visibleEdges } = filterVisibleGraphLayer(folded, layers, foldedTags);
    return { ...folded, nodes: visibleNodes, edges: visibleEdges };
  }, [depth, foldedTags, layers, snapshot]);

  const resources = useMemo(() => new Map(snapshot.nodes.map((node) => [node.id, node])), [snapshot.nodes]);
  const activeTag = activeTagId ? resources.get(`tag:${activeTagId}`) : null;
  const sizeById = useMemo(() => graphNodeSizes(presentation.nodes, presentation.edges), [presentation]);
  // Communities — the graphify reading: color answers "which area of the
  // workspace is this?". Derived from the tag taxonomy (root-tag groups),
  // deterministic across renders. See src/lib/graph/communities.ts.
  const communityAssignment = useMemo(
    () => assignGraphCommunities(presentation.nodes, presentation.edges),
    [presentation],
  );
  const liveGraphRef = useRef({
    presentation,
    sizeById,
    localPositions,
    selectedNodeId,
    onSelect,
    onSelectTag,
    onNodePositionChange,
    onHoverResource,
    layoutNonce,
    hubNodeId: snapshot.hub_node_id,
    communityByResource: communityAssignment.communityByResource,
    communities: communityAssignment.communities,
  });
  liveGraphRef.current = {
    presentation,
    sizeById,
    localPositions,
    selectedNodeId,
    onSelect,
    onSelectTag,
    onNodePositionChange,
    onHoverResource,
    layoutNonce,
    hubNodeId: snapshot.hub_node_id,
    communityByResource: communityAssignment.communityByResource,
    communities: communityAssignment.communities,
  };

  useEffect(() => {
    hoveredRef.current = hoveredResourceId;
    focusedRef.current = focusedResourceId;
    selectedRef.current = selectedNodeId ?? null;
    const graph = rendererRef.current?.getGraph();
    if (graph) {
      const ratio = rendererRef.current?.getCamera().getState().ratio ?? 1;
      const budget = graphFocusBudget(
        graph,
        hoveredResourceId ?? focusedResourceId ?? selectedNodeId ?? null,
        focusBudgetForRatio(ratio),
      );
      focusNodeLabelsRef.current = budget.nodeIds;
      focusEdgesRef.current = budget.edgeIds;
    }
    rendererRef.current?.scheduleRefresh();
  }, [focusedResourceId, hoveredResourceId, selectedNodeId]);

  useEffect(() => {
    const container = stageRef.current;
    if (!container) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void (async () => {
      const [sigmaModule, fa2Module, edgeCurveModule, nodeImageModule] = await Promise.all([
        import("sigma"),
        import("graphology-layout-forceatlas2"),
        import("@sigma/edge-curve"),
        import("@sigma/node-image"),
      ]);
      if (disposed) return;
      const SigmaConstructor = sigmaModule.default;
      const fa2: FA2Module = fa2Module.default;
      const EdgeCurveProgram = edgeCurveModule.default;
      const { EdgeCurvedArrowProgram } = edgeCurveModule;
      // "background" mode fills the disc with the node's own color and draws
      // the glyph over it, which is the whole point: the fill still answers
      // "which tag territory is this?" while the glyph answers "what is it?".
      const PictogramProgram = nodeImageModule.createNodeImageProgram({
        drawingMode: "background",
        keepWithinCircle: true,
        correctCentering: true,
        padding: 0.3,
      }) as unknown as NodeProgramType<SigmaNodeAttributes, SigmaEdgeAttributes>;
      const graph: OrganicGraph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>({ multi: true, type: "mixed" });
      const initial = liveGraphRef.current;
      reconcileOrganicGraph(
        graph,
        initial.presentation.nodes,
        initial.presentation.edges,
        initial.presentation.folded_member_counts,
        initial.sizeById,
        initial.localPositions,
        settledPositionsRef.current,
        initial.selectedNodeId,
        initial.hubNodeId,
        initial.communityByResource,
        initial.communities,
        paletteRef.current,
      );
      // Deterministic first paint: the layout settles SYNCHRONOUSLY before
      // Sigma ever draws a frame (graphify's stabilize-then-freeze, minus
      // the visible stabilization). No worker, no physics dance, no
      // "wrong first render that a reload happens to fix".
      settleLayout(graph, fa2, true, new Set(graph.nodes()), initial.hubNodeId != null);
      lastLaidOutNonceRef.current = initial.layoutNonce;

      const renderer = new SigmaConstructor<SigmaNodeAttributes, SigmaEdgeAttributes>(graph, container, {
        allowInvalidContainer: true,
        nodeProgramClasses: { pictogram: PictogramProgram },
        edgeProgramClasses: {
          curved: EdgeCurveProgram as unknown as EdgeProgramType<SigmaNodeAttributes, SigmaEdgeAttributes>,
          curvedArrow: EdgeCurvedArrowProgram as unknown as EdgeProgramType<SigmaNodeAttributes, SigmaEdgeAttributes>,
        },
        defaultEdgeType: "curved",
        defaultNodeColor: paletteRef.current.neutralNode,
        defaultEdgeColor: paletteRef.current.dimEdge,
        renderLabels: !compact,
        renderEdgeLabels: !compact,
        enableEdgeEvents: false,
        hideEdgesOnMove: graph.order > 500,
        hideLabelsOnMove: !alwaysShowLabels && graph.order > 220,
        // Canvas type follows the app: Figtree at label scale, not a 10px
        // monospace. The family arrives through the theme palette, which
        // reads it off the live stage — next/font's family is a generated
        // identifier and `ctx.font` cannot resolve a var().
        labelFont: paletteRef.current.fontFamily,
        labelSize: 11,
        labelWeight: "500",
        labelColor: { color: paletteRef.current.ink2 },
        edgeLabelFont: paletteRef.current.fontFamily,
        edgeLabelSize: 9,
        edgeLabelColor: { color: paletteRef.current.inkMute },
        defaultDrawNodeHover: makeDrawGraphNodeHover(paletteRef),
        // `alwaysShowLabels` (tags graph: few nodes, all labels meaningful)
        // disables the density/size budgets so every label always renders.
        // Otherwise labels appear progressively: the density budget admits
        // more of them as the camera zooms in (graphify hides low-degree
        // labels entirely until hover — same principle, smoother ramp).
        // 0 = nothing but forced labels, i.e. tags and the selection.
        labelDensity: alwaysShowLabels ? 100 : 0,
        labelGridCellSize: alwaysShowLabels ? 1 : 132,
        labelRenderedSizeThreshold: alwaysShowLabels ? 0 : 8.2,
        minCameraRatio: 0.035,
        maxCameraRatio: 5,
        stagePadding: compact ? 8 : 34,
        zIndex: true,
        nodeReducer: (node, data) => {
          // A node wears its glyph only while the glyph can be read; below
          // that it falls back to the plain circle, exactly as before.
          const scaled = data.type === "pictogram" && data.size / cameraRatioRef.current < GLYPH_MIN_RENDERED_SIZE
            ? { ...data, type: undefined, image: undefined }
            : data;
          const active = hoveredRef.current ?? focusedRef.current ?? selectedRef.current;
          if (!active || !graph.hasNode(active)) return scaled;
          if (node === active) return { ...scaled, highlighted: true, forceLabel: true, zIndex: 5 };
          if (graph.hasEdge(active, node) || graph.hasEdge(node, active)) {
            const showLabel = focusNodeLabelsRef.current.has(node);
            return { ...scaled, label: showLabel ? scaled.label : "", forceLabel: false, zIndex: showLabel ? 4 : 2 };
          }
          // Dimmed nodes drop the glyph too: a legible icon in a washed-out
          // disc reads as MORE important than its neighbours, not less.
          return { ...scaled, type: undefined, image: undefined, color: paletteRef.current.dimNode, label: "", zIndex: 0 };
        },
        edgeReducer: (edge, data) => {
          const active = hoveredRef.current ?? focusedRef.current ?? selectedRef.current;
          if (!active || !graph.hasNode(active)) return { ...data, label: "", forceLabel: false };
          const [source, target] = graph.extremities(edge);
          const incident = source === active || target === active;
          if (!incident) return { ...data, color: paletteRef.current.dimEdge, size: 0.32, label: "", forceLabel: false, zIndex: 0 };
          const prioritized = focusEdgesRef.current.has(edge);
          const showLabel = prioritized && data.layer !== "taxonomy";
          return {
            ...data,
            color: prioritized ? paletteRef.current.ink3 : paletteRef.current.line,
            size: prioritized ? data.size * 1.35 : Math.min(data.size, 0.65),
            label: showLabel ? data.label : "",
            forceLabel: showLabel,
            zIndex: prioritized ? 3 : 1,
          };
        },
      });
      rendererRef.current = renderer;
      setRendererReady((value) => value + 1);
      const camera = renderer.getCamera();
      const mouse = renderer.getMouseCaptor();
      let draggedNode: string | null = null;
      let moved = false;
      let suppressClick = false;

      const trackCameraRatio = () => { cameraRatioRef.current = camera.getState().ratio; };
      trackCameraRatio();
      camera.on("updated", trackCameraRatio);

      const refreshFocusBudget = () => {
        const active = hoveredRef.current ?? focusedRef.current ?? selectedRef.current;
        const budget = graphFocusBudget(graph, active, focusBudgetForRatio(camera.getState().ratio));
        focusNodeLabelsRef.current = budget.nodeIds;
        focusEdgesRef.current = budget.edgeIds;
        renderer.scheduleRefresh();
      };
      camera.on("updated", refreshFocusBudget);
      // Any camera movement invalidates an externally-anchored hover overlay
      // (the node's viewport position changed under it) — cancel, don't chase.
      const cancelExternalHover = () => liveGraphRef.current.onHoverResource?.(null);
      camera.on("updated", cancelExternalHover);

      const runLayout = (full: boolean, affectedIds: ReadonlySet<string>) => {
        cancelExternalHover();
        settleLayout(graph, fa2, full, affectedIds, liveGraphRef.current.hubNodeId != null);
        renderer.refresh();
        if (full) camera.setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
      };

      const syncGraph = () => {
        const current = liveGraphRef.current;
        const forceFull = lastLaidOutNonceRef.current !== current.layoutNonce;
        const changes = reconcileOrganicGraph(
          graph,
          current.presentation.nodes,
          current.presentation.edges,
          current.presentation.folded_member_counts,
          current.sizeById,
          current.localPositions,
          settledPositionsRef.current,
          current.selectedNodeId,
          current.hubNodeId,
          current.communityByResource,
          current.communities,
          paletteRef.current,
        );
        const active = hoveredRef.current ?? focusedRef.current ?? selectedRef.current;
        const budget = graphFocusBudget(graph, active, focusBudgetForRatio(camera.getState().ratio));
        focusNodeLabelsRef.current = budget.nodeIds;
        focusEdgesRef.current = budget.edgeIds;
        if (forceFull) lastLaidOutNonceRef.current = current.layoutNonce;
        if (forceFull || changes.topologyChanged) runLayout(forceFull, changes.affectedIds);
        else renderer.refresh();
      };
      syncGraphRef.current = syncGraph;

      renderer.on("enterNode", ({ node }) => {
        setHoveredResourceId(node);
        const emit = liveGraphRef.current.onHoverResource;
        if (emit && graph.hasNode(node)) {
          const point = renderer.graphToViewport({
            x: graph.getNodeAttribute(node, "x"),
            y: graph.getNodeAttribute(node, "y"),
          });
          emit({ resource: graph.getNodeAttribute(node, "resource"), x: point.x, y: point.y });
        }
      });
      renderer.on("leaveNode", () => {
        setHoveredResourceId(null);
        cancelExternalHover();
      });
      renderer.on("clickStage", () => {
        setActiveTagId(null);
        setFocusedResourceId(null);
      });
      renderer.on("clickNode", ({ node }) => {
        if (suppressClick) return;
        const resource = graph.getNodeAttribute(node, "resource");
        setFocusedResourceId(node);
        if (resource.resource_type === "tag") setActiveTagId(resource.tag.id);
        else liveGraphRef.current.onSelect?.(resource.id);
      });
      renderer.on("doubleClickNode", ({ node, preventSigmaDefault }) => {
        const resource = graph.getNodeAttribute(node, "resource");
        if (resource.resource_type !== "tag") return;
        preventSigmaDefault();
        liveGraphRef.current.onSelectTag?.(resource.tag.id);
      });
      renderer.on("downNode", ({ node, preventSigmaDefault }) => {
        // The workspace hub (or single filter-center tag) is a fixed
        // landmark: never draggable, always at the canvas center — camera
        // panning still works normally.
        if (node === liveGraphRef.current.hubNodeId) return;
        preventSigmaDefault();
        draggedNode = node;
        moved = false;
        cancelExternalHover();
        graph.setNodeAttribute(node, "fixed", true);
        camera.disable();
      });
      mouse.on("mousemovebody", ({ x, y }) => {
        if (!draggedNode) return;
        moved = true;
        const point = renderer.viewportToGraph({ x, y });
        graph.mergeNodeAttributes(draggedNode, { x: point.x, y: point.y, fixed: true });
        renderer.refresh({ partialGraph: { nodes: [draggedNode] }, skipIndexation: false });
      });
      mouse.on("mouseup", () => {
        if (!draggedNode) return;
        const node = draggedNode;
        draggedNode = null;
        camera.enable();
        if (!moved) return;
        suppressClick = true;
        window.setTimeout(() => { suppressClick = false; }, 0);
        const point = normalizedGraphPoint(graph, node);
        settledPositionsRef.current[node] = {
          x: graph.getNodeAttribute(node, "x"),
          y: graph.getNodeAttribute(node, "y"),
        };
        setLocalPositions((current) => ({ ...current, [node]: point }));
        liveGraphRef.current.onNodePositionChange?.(node, point);
      });

      const initialBudget = graphFocusBudget(
        graph,
        hoveredRef.current ?? focusedRef.current ?? selectedRef.current,
        focusBudgetForRatio(camera.getState().ratio),
      );
      focusNodeLabelsRef.current = initialBudget.nodeIds;
      focusEdgesRef.current = initialBudget.edgeIds;
      renderer.refresh();

      cleanup = () => {
        camera.off("updated", refreshFocusBudget);
        camera.off("updated", cancelExternalHover);
        cancelExternalHover();
        graph.forEachNode((id, attributes) => {
          settledPositionsRef.current[id] = { x: attributes.x, y: attributes.y };
        });
        if (syncGraphRef.current === syncGraph) syncGraphRef.current = null;
        if (rendererRef.current === renderer) rendererRef.current = null;
        renderer.kill();
      };
    })();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [compact, alwaysShowLabels]);

  useEffect(() => {
    syncGraphRef.current?.();
  }, [layoutNonce, localPositions, presentation, selectedNodeId, sizeById]);

  // Theme flip: restyle in place — colors only, never positions or camera.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const graph = renderer.getGraph();
    const current = liveGraphRef.current;
    graph.forEachNode((id, attributes) => {
      graph.setNodeAttribute(id, "color", resolveResourceColor(
        attributes.resource,
        current.communityByResource,
        current.communities,
        palette,
      ));
    });
    graph.forEachEdge((id, attributes) => {
      graph.setEdgeAttribute(id, "color", edgeColorForLayer(attributes.layer, palette));
    });
    renderer.setSettings({
      defaultNodeColor: palette.neutralNode,
      defaultEdgeColor: palette.dimEdge,
      labelColor: { color: palette.ink2 },
      edgeLabelColor: { color: palette.inkMute },
    });
    renderer.refresh();
  }, [palette]);

  // The open node is the camera's subject: whenever the selection (or the
  // free half of the stage) changes, fly there and zoom in enough to read
  // its neighborhood. Also runs once the renderer mounts with a selection.
  const previousSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    const renderer = rendererRef.current;
    const previous = previousSelectionRef.current;
    previousSelectionRef.current = selectedNodeId ?? null;
    if (!flyToSelection || !renderer) return;
    if (selectedNodeId) {
      flyToNode(renderer, selectedNodeId, focusAnchorX);
      return;
    }
    // Closed: release the emphasis and settle back on the whole graph.
    if (previous) {
      setFocusedResourceId(null);
      setActiveTagId(null);
      setHoveredResourceId(null);
      void renderer.getCamera().animatedReset({ duration: 650 });
    }
  }, [flyToSelection, selectedNodeId, focusAnchorX, rendererReady]);

  useEffect(() => {
    if (!focusedResourceId || presentation.nodes.some((node) => node.id === focusedResourceId)) return;
    const fallback = selectedNodeId && presentation.nodes.some((node) => node.id === selectedNodeId)
      ? selectedNodeId
      : snapshot.center_node_id && presentation.nodes.some((node) => node.id === snapshot.center_node_id)
        ? snapshot.center_node_id
        : null;
    setFocusedResourceId(fallback);
  }, [focusedResourceId, presentation.nodes, selectedNodeId, snapshot.center_node_id]);

  if (snapshot.nodes.length === 0) {
    return <GraphState icon={<GitBranch size={18} />} title="Nothing to graph">No canonical nodes match this view. Adjust its filters or choose a centered node.</GraphState>;
  }

  const toggleFold = (tagId: string) => {
    const next = new Set(foldedTags);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    setFoldedTags(next);
    onFoldedTagsChange?.([...next].sort());
  };
  const resetLayout = () => {
    settledPositionsRef.current = {};
    setLocalPositions({});
    setLayoutNonce((value) => value + 1);
    onResetNodePositions?.();
  };
  const moveFocus = (currentId: string, key: string) => {
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowDown") return;
    const graph = rendererRef.current?.getGraph();
    if (!graph) return;
    const positions = new Map<string, { x: number; y: number }>();
    graph.forEachNode((id, attributes) => positions.set(id, { x: attributes.x, y: attributes.y }));
    const target = nextGraphNodeId(currentId, key, positions);
    if (!target) return;
    setFocusedResourceId(target);
    keyboardRefs.current.get(target)?.focus();
  };
  const keyboardAnchorId = focusedResourceId ?? selectedNodeId ?? snapshot.center_node_id ?? presentation.nodes[0]?.id ?? null;
  const legendCommunities = communityAssignment.communities.slice(0, 8);

  return (
    <section aria-label={snapshot.mode === "centered" ? "Centered graph neighborhood" : "Graph query result"} className="h-full min-h-0">
      {/* The canvas is the app's own paper, flat: any texture or a different
          shade here leaves the panel visibly "bolted on" to the surfaces
          around it, so the graph just sits on `--paper` like everything else. */}
      <div className={cn(
        "relative h-full min-h-0 overflow-hidden bg-[var(--paper)]",
        compact ? "min-h-[150px] rounded-lg border border-[var(--line)]" : null,
      )}>
        <div ref={stageRef} data-graph-stage aria-hidden="true" className="absolute inset-0" />

        {!compact ? (
          <div data-graph-toolbar className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3">
            <Card className="pointer-events-auto max-w-[min(62vw,680px)] gap-0 p-2.5">
              {/* Title lives in the shell's content header — counts only. */}
              <p className="text-app-xs text-[var(--ink-3)]">
                {presentation.nodes.filter((node) => node.resource_type === "node").length} nodes · {presentation.nodes.filter((node) => node.resource_type === "tag").length} tags · {presentation.edges.length} links
              </p>
              {filters.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {filters.slice(0, 4).map((filter) => (
                    <Chip key={filter} size="sm" variant="soft">
                      <Chip.Label>{filter}</Chip.Label>
                    </Chip>
                  ))}
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {snapshot.layers.map((layer) => (
                  <ToggleButton
                    key={layer}
                    size="sm"
                    variant="ghost"
                    isSelected={layers.has(layer)}
                    onChange={() => setLayers((current) => { const next = new Set(current); if (next.has(layer)) next.delete(layer); else next.add(layer); return next; })}
                  >
                    {LAYER_LABELS[layer]}
                  </ToggleButton>
                ))}
                {snapshot.mode === "centered" ? (
                  <div className="ml-1 flex items-center gap-1 border-l border-[var(--line)] pl-2">
                    <span className="text-app-xs text-[var(--ink-mute)]">Depth</span>
                    {([1, 2, 3] as const).map((value) => (
                      <ToggleButton key={value} size="sm" variant="ghost" isIconOnly isSelected={depth === value} onChange={() => setDepth(value)} aria-label={`Depth ${value}`}>
                        {value}
                      </ToggleButton>
                    ))}
                  </div>
                ) : null}
              </div>
            </Card>

            <Card className="pointer-events-auto flex-row items-center gap-0.5 p-1">
              <GraphControl label="Zoom in" onClick={() => void rendererRef.current?.getCamera().animatedZoom({ factor: 1.45 })}><Plus size={14} /></GraphControl>
              <GraphControl label="Zoom out" onClick={() => void rendererRef.current?.getCamera().animatedUnzoom({ factor: 1.45 })}><Minus size={14} /></GraphControl>
              <GraphControl label="Fit graph" onClick={() => void rendererRef.current?.getCamera().animatedReset()}><Maximize2 size={14} /></GraphControl>
              <span className="mx-0.5 h-4 w-px bg-[var(--line)]" />
              <GraphControl label="Auto-arrange graph" onClick={resetLayout}><RefreshCw size={14} /></GraphControl>
            </Card>
          </div>
        ) : null}

        {!compact && activeTag?.resource_type === "tag" ? (
          <Card className="absolute bottom-12 left-1/2 z-30 -translate-x-1/2 flex-row items-center gap-2 p-1.5 pl-3">
            <Tags size={14} className="shrink-0 text-[var(--ink-3)]" />
            <span className="max-w-[240px] truncate text-app-xs font-medium text-[var(--ink)]">{activeTag.title}</span>
            <span className="text-app-xs text-[var(--ink-mute)]">{activeTag.assignment_count} nodes</span>
            <Button size="sm" variant="primary" onPress={() => toggleFold(activeTag.tag.id)}>
              {foldedTags.has(activeTag.tag.id) ? "Release" : "Fold"}
            </Button>
            <GraphControl label={`Open ${activeTag.title}`} onClick={() => onSelectTag?.(activeTag.tag.id)}><ExternalLink size={13} /></GraphControl>
            <GraphControl label="Close tag controls" onClick={() => setActiveTagId(null)}><X size={13} /></GraphControl>
          </Card>
        ) : null}

        {!compact && legendCommunities.length > 0 ? (
          <Card className="pointer-events-none absolute bottom-3 left-3 z-20 max-w-[calc(100%-24px)] flex-row flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5">
            {legendCommunities.map((community) => (
              <span key={community.key} className="flex items-center gap-1.5 text-app-xs text-[var(--ink-3)]">
                <i
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: community.key === UNTAGGED_COMMUNITY ? palette.neutralNode : communityColor(community.hue, palette.isDark) }}
                />
                {community.key === UNTAGGED_COMMUNITY ? community.label : `#${community.label}`}
                <span className="text-[var(--ink-mute)]">{community.size}</span>
              </span>
            ))}
            {presentation.hidden_node_ids.size > 0 ? <span className="border-l border-[var(--line)] pl-3 text-app-xs text-[var(--ink-mute)]">{presentation.hidden_node_ids.size} grouped in {foldedTags.size} tag{foldedTags.size === 1 ? "" : "s"}</span> : null}
          </Card>
        ) : null}

        <div className="sr-only" aria-live="polite">{`Graph settled with ${presentation.nodes.length} visible resources`}</div>
        <div className="sr-only" role="group" aria-label="Keyboard graph navigation">
          {presentation.nodes.map((resource) => (
            <button
              key={resource.id}
              ref={(element) => { if (element) keyboardRefs.current.set(resource.id, element); else keyboardRefs.current.delete(resource.id); }}
              type="button"
              data-resource-type={resource.resource_type}
              data-node-id={resource.resource_type === "node" ? resource.id : undefined}
              data-tag-id={resource.resource_type === "tag" ? resource.tag.id : undefined}
              tabIndex={keyboardAnchorId === resource.id ? 0 : -1}
              aria-label={`${resource.title}. ${describeNodeConnections(resource.id, presentation.edges, presentation.nodes)}`}
              onFocus={() => setFocusedResourceId(resource.id)}
              onKeyDown={(event) => {
                moveFocus(resource.id, event.key);
                if (event.key.startsWith("Arrow")) event.preventDefault();
              }}
              onClick={() => {
                if (resource.resource_type === "tag") setActiveTagId(resource.tag.id);
                else if (resource.resource_type === "node") onSelect?.(resource.id);
              }}
            >{resource.title}</button>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * Animate the camera so `id` lands at `anchorX` (fraction of the stage
 * width, vertically centered), zooming in when the view is wider than a
 * neighborhood. Sigma's camera lives in framed coordinates: the pixel offset
 * that moves the node off-center is converted at the TARGET ratio.
 */
function flyToNode(renderer: Sigma<SigmaNodeAttributes, SigmaEdgeAttributes>, id: string, anchorX: number): void {
  if (!renderer.getGraph().hasNode(id)) return;
  const display = renderer.getNodeDisplayData(id);
  if (!display) return;
  const camera = renderer.getCamera();
  const state = camera.getState();
  const ratio = Math.min(state.ratio, 0.34);
  const { width } = renderer.getDimensions();
  if (width <= 0) return;
  const override = { cameraState: { ...state, ratio } };
  const left = renderer.viewportToFramedGraph({ x: 0, y: 0 }, override);
  const right = renderer.viewportToFramedGraph({ x: width, y: 0 }, override);
  const framedPerPixel = (right.x - left.x) / width;
  const x = display.x + (0.5 - anchorX) * width * framedPerPixel;
  void camera.animate({ x, y: display.y, ratio }, { duration: 620, easing: "quadraticInOut" });
}

/** One canvas control: a HeroUI icon button with the app's tooltip delay. */
function GraphControl({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip delay={400}>
      <Button isIconOnly size="sm" variant="ghost" aria-label={label} onPress={onClick}>
        {children}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}

function GraphState({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <div className="flex h-full min-h-[180px] items-center justify-center bg-[var(--paper)] p-6"><div className="max-w-sm text-center text-[var(--ink-3)]"><div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--line)]">{icon}</div><p className="text-app-sm font-medium text-[var(--ink)]">{title}</p><p className="mt-1 text-app-xs leading-relaxed">{children}</p></div></div>;
}

/** A bug is red, but quieter than a credential: it is a state, not a secret. */
const BUG_TINT = 0.42;

/**
 * The fill a node earns by MEANING something, or null when it means nothing
 * in particular.
 *
 * Kind is not a color dimension here. Everywhere else in the app a kind is a
 * glyph in `--ink-3` (`node-kind-icon.ts`) and color is reserved for
 * HeroUI's semantics — `default | warning | danger | accent`. The graph used
 * to hand every one of the ten kinds its own hue, which is a vocabulary that
 * exists nowhere else in the product; that is most of why it read as bolted
 * on. So: neutral unless the node is genuinely one of the app's semantics.
 */
function semanticNodeColor(resource: GraphResourcePayload, palette: GraphPalette): string | null {
  if (resource.resource_type !== "node") return null;
  // A secret stays a secret whatever its status.
  if (resource.kind === "credential") return palette.danger;
  // A goal is not one more kind among the kinds: it is what the rest of the
  // map is FOR. So it takes the app's accent — the one hue reserved for "this
  // is the thing" — and reads as a layer above the tag territories instead of
  // as another tag's colour. Like a credential, it keeps it whatever its
  // health says: an objective does not stop being an objective for drifting.
  //
  // This is the fallback, not the rule: `resolveResourceColor` gives an
  // explicit payload `color` absolute precedence, which is how the North Star
  // keeps the workspace hub's gradient and how the company goals keep their
  // end of it. What lands here is everything the strategy ring did not paint
  // — project goals, above all.
  if (resource.kind === "goal") return palette.accent;
  // Everything else that is done or archived is history: it goes quiet and
  // takes the ordinary tag tint.
  if (isTerminalStatus(resource.status)) return null;
  if (resource.kind === "bug") return mixColors(palette.danger, palette.paper, BUG_TINT);
  if (resource.status === "blocked") return palette.warning;
  return null;
}

/**
 * Resolve a resource's fill.
 *
 * Precedence: an explicit payload color (the workspace hub's own gradient),
 * then the app's semantics, then the tag territory the resource belongs to.
 *
 * Content wears its tag's color at full strength, exactly like the tag hub
 * does. It was tinted 84% toward the paper at first, on the theory that a
 * hundred saturated dots would fight each other — but on the dark theme
 * "toward the paper" means toward black, so content sank into the background
 * and the map lost the one thing the color was for: seeing at a glance which
 * territory a point belongs to. Tags stay legible against their own members
 * by being bigger and by being the only things with a name on them, which is
 * a stronger separation than a tint ever was. Nested tags still lift toward
 * the paper by depth, so a taxonomy branch reads as one family.
 */
function resolveResourceColor(
  resource: GraphResourcePayload,
  communityByResource: ReadonlyMap<string, string>,
  communities: readonly GraphCommunity[],
  palette: GraphPalette,
): string {
  if (resource.color) return resource.color;
  const semantic = semanticNodeColor(resource, palette);
  if (semantic) return semantic;
  const key = communityByResource.get(resource.id) ?? UNTAGGED_COMMUNITY;
  const community = key === UNTAGGED_COMMUNITY
    ? undefined
    : communities.find((entry) => entry.key === key);
  if (!community) return palette.neutralNode;
  const isTag = resource.resource_type === "tag";
  return communityColor(community.hue, palette.isDark, isTag ? resource.depth : 1);
}

function edgeColorForLayer(layer: GraphLayer, palette: GraphPalette): string {
  return mixColors(palette.paper, palette.ink, EDGE_INK_MIX[layer]);
}

/**
 * Settle the layout synchronously, before the first painted frame.
 *
 * Two regimes. A hub snapshot keeps the radial layout it arrived with and
 * only gets overlap relaxation. Everything else (centered neighborhoods,
 * plain query results) has no designed geometry to protect, so it gets the
 * ForceAtlas2 pass: deterministic (seeded positions in, same positions out),
 * respecting `fixed` nodes, with an iteration budget scaled by graph size.
 * Partial settles freeze everything outside `affectedIds` either way, so a
 * realtime insert cannot reshuffle the map the user is reading.
 */
function settleLayout(
  graph: OrganicGraph,
  fa2: FA2Module,
  full: boolean,
  affectedIds: ReadonlySet<string>,
  hasHub: boolean,
): void {
  if (graph.order <= 1 || graph.size === 0) {
    if (full && !hasHub) compactGraphComponents(graph);
    return;
  }
  // A hub snapshot ALREADY carries a designed layout: the engine puts the
  // workspace hub at the center, the tags on depth rings in wedges whose
  // width is proportional to how much of the workspace lives under them, and
  // each content node on a sunflower orbit inside its own tag's wedge
  // (`buildTagHierarchyLayout` / `knowledgeHubPositions` in the contract).
  // Running ForceAtlas2 over it would undo that: the hub and tags hold
  // because they are pinned, but every content node gets dragged out of its
  // orbit by global repulsion and by whatever cross-links it has, and the
  // disc arrives as a hairball. Here the seed IS the layout, and the only
  // thing left to do is stop nodes from sitting on top of each other.
  if (hasHub) {
    relaxOverlaps(graph, full ? null : affectedIds);
    return;
  }
  const temporaryFixed = new Map<string, boolean>();
  if (!full) {
    graph.forEachNode((id, attributes) => {
      temporaryFixed.set(id, attributes.fixed);
      if (!attributes.fixed && !affectedIds.has(id)) graph.setNodeAttribute(id, "fixed", true);
    });
  }
  const order = graph.order;
  const iterations = full
    ? order > 600 ? 90 : order > 250 ? 150 : order > 80 ? 240 : 340
    : 110;
  fa2.assign(graph, {
    iterations,
    settings: {
      adjustSizes: true,
      barnesHutOptimize: order > 120,
      barnesHutTheta: 0.6,
      edgeWeightInfluence: 1,
      gravity: full ? (order > 150 ? 0.6 : 0.45) : 0.8,
      scalingRatio: order <= 20 ? 3 : order > 250 ? 8.5 : 5.5,
      slowDown: order > 300 ? 7 : 5,
      strongGravityMode: false,
    },
    getEdgeWeight: (_edge, attributes) => LAYOUT_EDGE_WEIGHTS[(attributes as SigmaEdgeAttributes).layer],
  });
  for (const [id, fixed] of temporaryFixed) {
    if (graph.hasNode(id)) graph.setNodeAttribute(id, "fixed", fixed);
  }
  if (full) compactGraphComponents(graph);
}

/**
 * Run the overlap pass over the live graph. `affectedIds` (a partial settle)
 * freezes everything else, exactly like the ForceAtlas2 path does.
 */
function relaxOverlaps(graph: OrganicGraph, affectedIds: ReadonlySet<string> | null): void {
  const nodes: OverlapRelaxationNode[] = [];
  graph.forEachNode((id, attributes) => {
    nodes.push({
      id,
      x: attributes.x,
      y: attributes.y,
      size: attributes.size,
      fixed: attributes.fixed || (affectedIds ? !affectedIds.has(id) : false),
    });
  });
  for (const [id, point] of relaxNodeOverlaps(nodes)) graph.mergeNodeAttributes(id, point);
}

function reconcileOrganicGraph(
  graph: OrganicGraph,
  resources: readonly GraphResourcePayload[],
  edges: readonly GraphEdgePayload[],
  foldedMemberCounts: ReadonlyMap<string, number>,
  sizeById: ReadonlyMap<string, number>,
  persistedPositions: Record<string, { x: number; y: number }>,
  settledPositions: Record<string, { x: number; y: number }>,
  selectedNodeId: string | null | undefined,
  hubNodeId: string | null | undefined,
  communityByResource: ReadonlyMap<string, string>,
  communities: readonly GraphCommunity[],
  palette: GraphPalette,
): { topologyChanged: boolean; affectedIds: Set<string> } {
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const desiredEdges = edges.filter((edge) =>
    edge.from !== edge.to && resourceById.has(edge.from) && resourceById.has(edge.to),
  );
  const desiredEdgeIds = new Set(desiredEdges.map((edge) => edge.id));
  const affectedIds = new Set<string>();
  let topologyChanged = false;

  for (const edgeId of graph.edges()) {
    if (desiredEdgeIds.has(edgeId)) continue;
    const [from, to] = graph.extremities(edgeId);
    affectedIds.add(from);
    affectedIds.add(to);
    graph.dropEdge(edgeId);
    topologyChanged = true;
  }
  for (const id of graph.nodes()) {
    if (resourceById.has(id)) continue;
    settledPositions[id] = {
      x: graph.getNodeAttribute(id, "x"),
      y: graph.getNodeAttribute(id, "y"),
    };
    graph.forEachNeighbor(id, (neighbor) => affectedIds.add(neighbor));
    graph.dropNode(id);
    topologyChanged = true;
  }

  const orderedResources = [...resources].sort((a, b) => a.id.localeCompare(b.id));
  for (const resource of orderedResources) {
    const persisted = persistedPositions[resource.id];
    const size = sizeById.get(resource.id) ?? 6;
    const foldedCount = resource.resource_type === "tag"
      ? foldedMemberCounts.get(resource.id) ?? 0
      : 0;
    const fill = resolveResourceColor(resource, communityByResource, communities, palette);
    const glyphKey = glyphKeyForResource(resource, hubNodeId);
    const display = {
      size: foldedCount > 0 ? Math.min(8, size + Math.log1p(foldedCount) * 0.7) : size,
      label: foldedCount > 0 ? `${resource.title} · ${foldedCount}` : resource.title,
      color: fill,
      // The glyph is inked against THIS node's fill, which ranges from a
      // barely-tinted paper to full danger red on the same canvas — one fixed
      // ink would disappear on some of them.
      image: glyphKey ? kindGlyphDataUri(glyphKey, readableInkOn(fill, palette)) : undefined,
      type: glyphKey ? "pictogram" : undefined,
      resource,
      community: communityByResource.get(resource.id) ?? UNTAGGED_COMMUNITY,
      fixed: Boolean(persisted),
      // ONLY tags carry a name on the canvas.
      //
      // Content titles are sentences — "Agent-first refocus: retire the CLI
      // and make MCP the only agent surface" — and a hundred of
      // them at once overlapped into a wall of text that hid the graph it was
      // annotating. The density budget did not save it: any budget generous
      // enough to be useful was already too dense to read. So the map is
      // labelled the way a map is: the territories are named, the individual
      // points are not, and a point gives up its title on hover or when it is
      // selected. The title stays on the attributes for exactly that.
      forceLabel: resource.id === selectedNodeId || foldedCount > 0
        || resource.resource_type === "tag",
      // The workspace hub is the landmark — always drawn above anything
      // that drifts or gets dragged over the canvas center.
      zIndex: resource.id === hubNodeId ? 3 : resource.resource_type === "tag" ? 2 : 1,
    };
    if (graph.hasNode(resource.id)) {
      graph.mergeNodeAttributes(resource.id, display);
      continue;
    }

    // Seed precedence — the root cause of the old "first paint is wrong,
    // reload fixes it" bug lived here: a neighbor-centroid heuristic used
    // to OVERRIDE the engine-computed position for every node inserted
    // into a non-empty graph, so the designed radial layout never survived
    // the first mount (and with everything pinned, ForceAtlas2 never
    // repaired it either). Now the engine's deterministic coordinates are
    // authoritative; in-session settled positions win only for nodes the
    // user already saw settle.
    const remembered = settledPositions[resource.id];
    const seed = remembered ?? persistedToGraphPoint(persisted ?? { x: resource.x, y: resource.y });
    graph.addNode(resource.id, { x: seed.x, y: seed.y, ...display });
    affectedIds.add(resource.id);
    for (const edge of desiredEdges) {
      if (edge.from === resource.id) affectedIds.add(edge.to);
      if (edge.to === resource.id) affectedIds.add(edge.from);
    }
    topologyChanged = true;
  }

  for (const edge of desiredEdges) {
    const attributes = sigmaEdgeAttributes(edge, palette, communityByResource);
    if (graph.hasEdge(edge.id)) {
      const [currentFrom, currentTo] = graph.extremities(edge.id);
      const sameEndpoints = edge.directed
        ? currentFrom === edge.from && currentTo === edge.to
        : (currentFrom === edge.from && currentTo === edge.to)
          || (currentFrom === edge.to && currentTo === edge.from);
      if (graph.isDirected(edge.id) !== edge.directed || !sameEndpoints) {
        graph.dropEdge(edge.id);
        if (edge.directed) graph.addDirectedEdgeWithKey(edge.id, edge.from, edge.to, attributes);
        else graph.addUndirectedEdgeWithKey(edge.id, edge.from, edge.to, attributes);
        affectedIds.add(edge.from);
        affectedIds.add(edge.to);
        topologyChanged = true;
      } else {
        graph.mergeEdgeAttributes(edge.id, attributes);
      }
      continue;
    }
    if (edge.directed) graph.addDirectedEdgeWithKey(edge.id, edge.from, edge.to, attributes);
    else graph.addUndirectedEdgeWithKey(edge.id, edge.from, edge.to, attributes);
    affectedIds.add(edge.from);
    affectedIds.add(edge.to);
    topologyChanged = true;
  }

  for (const id of [...affectedIds]) if (!graph.hasNode(id)) affectedIds.delete(id);
  return { topologyChanged, affectedIds };
}

/**
 * Curvature for an edge that leaves its own territory.
 *
 * A structural edge is short: it runs from a node to its own tag hub, inside
 * one wedge. A cross-link between two communities is a CHORD, and with a
 * near-straight chord the shortest path between two wedges runs through the
 * middle of the disc — straight over the workspace hub and over every other
 * wedge on the way. Bowing those edges hard pushes them out of the center, so
 * they read as going around the outside rather than through everything.
 */
const CROSS_COMMUNITY_CURVATURE = 0.42;

function sigmaEdgeAttributes(
  edge: GraphEdgePayload,
  palette: GraphPalette,
  communityByResource: ReadonlyMap<string, string>,
): SigmaEdgeAttributes {
  const rawLabel = edge.aggregate_count && edge.aggregate_count > 1
    ? `${edge.label} (${edge.aggregate_count})`
    : edge.label;
  const fromCommunity = communityByResource.get(edge.from);
  const toCommunity = communityByResource.get(edge.to);
  const crossesCommunity = fromCommunity !== undefined
    && toCommunity !== undefined
    && fromCommunity !== toCommunity;
  const baseCurvature = stableCurvature(edge.id);
  return {
    // Membership is already encoded by the tag hub and line. Repeating
    // "tagged" hundreds of times is pure visual noise.
    label: edge.layer === "taxonomy" ? "" : rawLabel,
    color: edgeColorForLayer(edge.layer, palette),
    size: edge.layer === "dependencies" ? 1.2 : edge.layer === "taxonomy" ? 0.65 : 0.8,
    type: edge.directed ? "curvedArrow" : "curved",
    curvature: crossesCommunity
      ? Math.sign(baseCurvature) * CROSS_COMMUNITY_CURVATURE
      : baseCurvature,
    forceLabel: false,
    layer: edge.layer,
  };
}

function graphFocusBudget(
  graph: OrganicGraph,
  active: string | null,
  limit = 8,
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  if (!active || !graph.hasNode(active)) return { nodeIds: new Set(), edgeIds: new Set() };
  const neighbors: Array<{ id: string; score: number }> = [];
  graph.forEachNeighbor(active, (id, attributes) => {
    neighbors.push({ id, score: attributes.size + (attributes.resource.resource_type === "tag" ? 2 : 0) });
  });
  neighbors.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const nodeIds = new Set(neighbors.slice(0, limit).map((entry) => entry.id));
  const candidateEdges: Array<{ id: string; rank: number }> = [];
  graph.forEachEdge(active, (id, attributes, from, to) => {
    const other = from === active ? to : from;
    if (!nodeIds.has(other)) return;
    const rank = attributes.layer === "dependencies" ? 0
      : attributes.layer === "hierarchy" ? 1
        : attributes.layer === "references" ? 2
          : attributes.layer === "taxonomy" ? 3
            : 4;
    candidateEdges.push({ id, rank });
  });
  candidateEdges.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  return { nodeIds, edgeIds: new Set(candidateEdges.slice(0, limit).map((entry) => entry.id)) };
}

function focusBudgetForRatio(ratio: number): number {
  if (ratio <= 0.08) return 24;
  if (ratio <= 0.16) return 16;
  if (ratio <= 0.28) return 12;
  return 8;
}

function compactGraphComponents(graph: OrganicGraph): void {
  const nodes: Array<{ id: string; x: number; y: number; fixed: boolean }> = [];
  const edges: Array<{ from: string; to: string }> = [];
  graph.forEachNode((id, attributes) => {
    nodes.push({ id, x: attributes.x, y: attributes.y, fixed: attributes.fixed });
  });
  graph.forEachEdge((_id, _attributes, from, to) => edges.push({ from, to }));
  const packed = packDisconnectedComponents(nodes, edges);
  for (const [id, point] of packed) graph.mergeNodeAttributes(id, point);
}

function persistedToGraphPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: (point.x - 0.5) * 100, y: (point.y - 0.5) * 100 };
}

function normalizedGraphPoint(graph: OrganicGraph, id: string): { x: number; y: number } {
  const extent = graphExtent(graph);
  const x = graph.getNodeAttribute(id, "x");
  const y = graph.getNodeAttribute(id, "y");
  const normalize = (value: number, min: number, max: number) => max === min ? 0.5 : 0.08 + ((value - min) / (max - min)) * 0.84;
  return {
    x: clamp(normalize(x, extent.minX, extent.maxX), 0.04, 0.96),
    y: clamp(normalize(y, extent.minY, extent.maxY), 0.04, 0.96),
  };
}

function graphExtent(graph: OrganicGraph) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  graph.forEachNode((_id, attributes) => {
    minX = Math.min(minX, attributes.x);
    maxX = Math.max(maxX, attributes.x);
    minY = Math.min(minY, attributes.y);
    maxY = Math.max(maxY, attributes.y);
  });
  return { minX, maxX, minY, maxY };
}

function stableCurvature(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = Math.imul(31, hash) + id.charCodeAt(index) | 0;
  return (hash & 1 ? -1 : 1) * (0.12 + (Math.abs(hash) % 5) * 0.025);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Hover bubble + halo, drawn with the live theme palette (both themes). */
function makeDrawGraphNodeHover(paletteRef: { current: GraphPalette }) {
  return function drawGraphNodeHover(
    context: CanvasRenderingContext2D,
    data: { x: number; y: number; size: number; label: string | null; color: string },
  ) {
    const palette = paletteRef.current;
    const rawLabel = data.label ?? "";
    const label = rawLabel.length > 42 ? `${rawLabel.slice(0, 41)}…` : rawLabel;
    context.save();
    context.font = `500 11px ${palette.fontFamily}`;
    const width = Math.ceil(context.measureText(label).width) + 14;
    const bubbleX = data.x + data.size + 5;
    const bubbleY = data.y - 11;
    context.fillStyle = palette.hoverBg;
    context.beginPath();
    context.roundRect(bubbleX, bubbleY, width, 22, 6);
    context.fill();
    context.strokeStyle = palette.line;
    context.lineWidth = 1;
    context.stroke();
    context.beginPath();
    context.arc(data.x, data.y, data.size + 2.5, 0, Math.PI * 2);
    context.strokeStyle = palette.hoverRing;
    context.lineWidth = 1.5;
    context.stroke();
    context.fillStyle = palette.ink;
    context.textBaseline = "middle";
    context.fillText(label, bubbleX + 7, data.y);
    context.restore();
  };
}
