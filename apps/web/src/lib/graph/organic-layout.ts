/**
 * Pure post-passes over the 2D graph layout, run after ForceAtlas2 settles:
 * packing disconnected islands and pushing overlapping nodes apart. Plain
 * coordinates in, coordinates out — no sigma, no DOM — so the graph view can
 * run them in a worker or a test alike. Every pass is deterministic (ids are
 * sorted before any iteration) so the same snapshot always lays out the same.
 */
/** `fixed` marks a position the person dragged and persisted; passes leave those alone. */
export interface OrganicLayoutNode {
  id: string;
  x: number;
  y: number;
  fixed?: boolean;
}

export interface OrganicLayoutEdge {
  from: string;
  to: string;
}

interface ComponentBox {
  ids: string[];
  key: string;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  packedX: number;
  packedY: number;
}

/**
 * Pack disconnected islands after the force simulation settles.
 *
 * ForceAtlas2 is useful inside a connected component, but its global
 * repulsion leaves small disconnected components spread across the whole
 * camera extent. This pass only translates complete components: relative
 * node positions and therefore the shape of every connected subgraph stay
 * unchanged.
 */
export function packDisconnectedComponents(
  nodes: readonly OrganicLayoutNode[],
  edges: readonly OrganicLayoutEdge[],
): Map<string, { x: number; y: number }> {
  const orderedNodes = [...nodes]
    .filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y))
    .sort((a, b) => a.id.localeCompare(b.id));
  const original = new Map(orderedNodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  if (orderedNodes.length < 2) return original;

  // Persisted drag positions are an explicit user layout. Auto-arrange clears
  // them before invoking this pass, so silently moving them here would be a
  // surprising override.
  if (orderedNodes.some((node) => node.fixed)) return original;

  const nodeIds = new Set(orderedNodes.map((node) => node.id));
  const adjacency = new Map(orderedNodes.map((node) => [node.id, new Set<string>()]));
  const validEdges = edges
    .filter((edge) => edge.from !== edge.to && nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`));
  for (const edge of validEdges) {
    adjacency.get(edge.from)!.add(edge.to);
    adjacency.get(edge.to)!.add(edge.from);
  }

  const components: string[][] = [];
  const visited = new Set<string>();
  for (const node of orderedNodes) {
    if (visited.has(node.id)) continue;
    const component: string[] = [];
    const queue = [node.id];
    visited.add(node.id);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor]!;
      component.push(id);
      for (const neighbor of [...(adjacency.get(id) ?? [])].sort()) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(component.sort());
  }
  if (components.length < 2) return original;

  const edgeLengths = validEdges
    .map((edge) => {
      const from = original.get(edge.from)!;
      const to = original.get(edge.to)!;
      return Math.hypot(from.x - to.x, from.y - to.y);
    })
    .filter((length) => Number.isFinite(length) && length > 0.01)
    .sort((a, b) => a - b);
  const medianEdgeLength = edgeLengths.length > 0
    ? edgeLengths[Math.floor(edgeLengths.length / 2)]!
    : 12;
  const layoutUnit = clamp(medianEdgeLength, 6, 24);
  const minimumSpan = layoutUnit * 0.48;
  const gap = layoutUnit * 0.2;

  const boxes = components.map((ids): ComponentBox => {
    const points = ids.map((id) => original.get(id)!);
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    return {
      ids,
      key: ids[0]!,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      width: Math.max(maxX - minX, minimumSpan),
      height: Math.max(maxY - minY, minimumSpan),
      packedX: 0,
      packedY: 0,
    };
  }).sort((a, b) =>
    (b.width * b.height) - (a.width * a.height)
      || b.height - a.height
      || b.width - a.width
      || a.key.localeCompare(b.key),
  );

  // A landscape shelf fits the graph canvas while keeping singletons close
  // to the nearest component. Component dimensions include a minimum visual
  // footprint so isolated nodes cannot collapse onto one another.
  const paddedArea = boxes.reduce((sum, box) => sum + (box.width + gap) * (box.height + gap), 0);
  const targetWidth = Math.max(
    ...boxes.map((box) => box.width),
    Math.sqrt(paddedArea * 1.55),
  );
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let packedWidth = 0;
  for (const box of boxes) {
    if (cursorX > 0 && cursorX + box.width > targetWidth) {
      cursorX = 0;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }
    box.packedX = cursorX;
    box.packedY = cursorY;
    cursorX += box.width + gap;
    rowHeight = Math.max(rowHeight, box.height);
    packedWidth = Math.max(packedWidth, cursorX - gap);
  }
  const packedHeight = cursorY + rowHeight;
  const targetCenter = orderedNodes.reduce(
    (sum, node) => ({ x: sum.x + node.x / orderedNodes.length, y: sum.y + node.y / orderedNodes.length }),
    { x: 0, y: 0 },
  );
  const originX = targetCenter.x - packedWidth / 2;
  const originY = targetCenter.y - packedHeight / 2;
  const packed = new Map<string, { x: number; y: number }>();

  for (const box of boxes) {
    const nextCenterX = originX + box.packedX + box.width / 2;
    const nextCenterY = originY + box.packedY + box.height / 2;
    const dx = nextCenterX - box.centerX;
    const dy = nextCenterY - box.centerY;
    for (const id of box.ids) {
      const point = original.get(id)!;
      packed.set(id, { x: point.x + dx, y: point.y + dy });
    }
  }

  return new Map([...packed.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface OverlapRelaxationNode {
  id: string;
  x: number;
  y: number;
  /** Sigma node size (pixels at camera ratio 1). */
  size: number;
  fixed?: boolean;
}

/**
 * Sigma sizes are pixels at ratio 1 while positions are graph units; at the
 * camera's fit ratio for a hub snapshot the two are close to this factor.
 * Only the RATIO between it and the layout's own radii matters — it decides
 * how much air two touching nodes end up with, nothing else.
 */
const SIZE_TO_LAYOUT_UNITS = 0.16;
/** Move a little per pass: overshooting turns separation into its own jitter. */
const RELAXATION_RATE = 0.55;

/**
 * Push overlapping nodes apart, and do nothing else.
 *
 * The alternative in hub snapshots was ForceAtlas2, which does resolve
 * overlaps — via global repulsion that also drags every unpinned node out of
 * the radial layout the engine designed for it (`buildTagHierarchyLayout`:
 * tags on depth rings, content on sunflower orbits inside its tag's wedge).
 * The map came out a hairball and the designed geometry was never seen. This
 * pass is the part that was actually wanted: no attraction, no long-range
 * repulsion, no gravity — a node moves only when it is sitting on top of
 * another one, and only far enough to stop.
 *
 * Deterministic (pairs visited in id order, same input → same output) and
 * `fixed` nodes never move: the hub, the tag ring and user-dragged anchors
 * stay exactly where they were put.
 */
export function relaxNodeOverlaps(
  nodes: readonly OverlapRelaxationNode[],
  iterations = 60,
): Map<string, { x: number; y: number }> {
  const ordered = [...nodes]
    .filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y))
    .sort((a, b) => a.id.localeCompare(b.id));
  const points = new Map(ordered.map((node) => [node.id, { x: node.x, y: node.y }]));
  if (ordered.length < 2) return points;

  const radius = new Map(ordered.map((node) => [node.id, Math.max(0, node.size) * SIZE_TO_LAYOUT_UNITS]));
  const movable = new Map(ordered.map((node) => [node.id, !node.fixed]));

  for (let pass = 0; pass < iterations; pass++) {
    let moved = false;
    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i]!;
      const pointA = points.get(a.id)!;
      for (let j = i + 1; j < ordered.length; j++) {
        const b = ordered[j]!;
        const movableA = movable.get(a.id)!;
        const movableB = movable.get(b.id)!;
        if (!movableA && !movableB) continue;
        const pointB = points.get(b.id)!;
        const minimum = radius.get(a.id)! + radius.get(b.id)!;
        if (minimum <= 0) continue;
        let dx = pointB.x - pointA.x;
        let dy = pointB.y - pointA.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= minimum) continue;
        if (distance < 1e-6) {
          // Exactly co-located: separate along a deterministic axis derived
          // from the pair's position in the ordering, never a random one.
          const angle = ((i * ordered.length + j) % 360) * (Math.PI / 180);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        const push = ((minimum - distance) / distance) * RELAXATION_RATE;
        const shiftX = dx * push;
        const shiftY = dy * push;
        const shareA = movableA ? (movableB ? 0.5 : 1) : 0;
        const shareB = movableB ? (movableA ? 0.5 : 1) : 0;
        pointA.x -= shiftX * shareA;
        pointA.y -= shiftY * shareA;
        pointB.x += shiftX * shareB;
        pointB.y += shiftY * shareB;
        moved = true;
      }
    }
    if (!moved) break;
  }

  return new Map([...points.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
