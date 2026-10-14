import type { ComponentType } from "react";
import {
  Bug,
  CheckSquare2,
  FileText,
  Gavel,
  KeyRound,
  Layers,
  ScrollText,
  Table2,
  Target,
  Users2,
  Wrench,
} from "lucide-react";
import type { NodeKind } from "@bcontext-dev/contract/types";

export type NodeKindIcon = ComponentType<{ size?: number; className?: string }>;

/**
 * One glyph per node kind — the single vocabulary shared by the dashboard
 * twins (dashboard-list-row.tsx) and the saved list renderer
 * (saved-list-view.tsx), so a decision looks like the same decision on
 * every list surface.
 */
export const NODE_KIND_ICONS: Record<NodeKind, NodeKindIcon> = {
  doc: FileText,
  task: CheckSquare2,
  decision: Gavel,
  meeting: Users2,
  bug: Bug,
  adr: ScrollText,
  entity: Layers,
  skill: Wrench,
  data: Table2,
  credential: KeyRound,
  goal: Target,
};

export function nodeKindIcon(kind: NodeKind): NodeKindIcon {
  return NODE_KIND_ICONS[kind] ?? FileText;
}
