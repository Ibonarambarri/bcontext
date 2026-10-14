/**
 * The roadmap payload of a resolved `roadmap` view — what
 * `POST /api/views/:id/resolve` and `views(op=resolve)` add next to the node
 * ids. The rows are the workspace's goals, read in full because the
 * timeframe and key results live in `data` and the summary index does not
 * carry them; the cards are the resolved nodes; the edges say which card
 * pushes which goal and what blocks what. The model itself is the contract's
 * `buildRoadmap`, so the web and an agent read the same rows.
 */
import { buildRoadmap, type RoadmapModel } from "@bcontext-dev/contract/roadmap/model";
import type { KnowledgeNode, NodeEdge } from "@bcontext-dev/contract/types";
import type { SavedView } from "@bcontext-dev/contract/views/types";
import type { Storage } from "@/lib/storage";

/** Goals are few; this is the same ceiling the goals tool reads with. */
const GOAL_SCAN_LIMIT = 2_000;

export async function buildRoadmapPayload(
  storage: Storage,
  view: SavedView,
  resultIds: readonly string[],
  index: KnowledgeNode[],
  edges: NodeEdge[],
  today?: string,
): Promise<RoadmapModel> {
  const goals = await storage.listNodes({ kinds: ["goal"], limit: GOAL_SCAN_LIMIT });
  const wanted = new Set(resultIds);
  const items = index.filter((node) => wanted.has(node.id));
  return buildRoadmap({ goals, items, index, edges, today, presentation: view.presentation });
}
