"use client";

/**
 * The floating node panel's body, chosen by kind. `node-inspector.tsx`
 * owns the header, the identity strip and the Details door and hands the
 * rest to `PanelBodyForKind`, which reads the plan from `body-for-kind.ts`
 * and mounts the matching body — each in its own file next to this one.
 *
 * Every body edits in place when the person can write: prose through the
 * same TipTap/Yjs editor as the page (`prose-body.tsx`), structured kinds
 * through their own guarded forms. Writes a body makes on its own (the
 * editor's save, a subtask op, a key result) hand the server's node back
 * through `onWritten`, so the panel's `updated_at` stays current for the
 * next guarded patch; a 409 anywhere calls `onConflict`, and the panel
 * reloads and says so.
 */

import dynamic from "next/dynamic";
import { DetailSkeleton } from "@/components/skeletons";
import { CredentialNodeView } from "@/components/credential-node-view";
import { SkillNodeView } from "@/components/skill-node-view";
import type { NodeInspectorPayload } from "@bcontext-dev/contract/node-inspector";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { panelPlanFor, type PanelBody } from "./body-for-kind";
import { EntityBody } from "./entity-body";
import { GoalBody } from "./goal-body";
import { MeetingBody } from "./meeting-body";
import { PanelProse } from "./prose-body";
import { WorkBody } from "./work-body";

// A dataset view carries the grid, the drop zone and the query plumbing —
// weight the panel should only pay for when the node it opened is a dataset.
const DataNodeView = dynamic(
  () => import("@/components/data-node-view").then((m) => m.DataNodeView),
  { ssr: false, loading: () => <DetailSkeleton /> },
);

export interface PanelBodyProps {
  payload: NodeInspectorPayload;
  workspace: WorkspaceAddress;
  canWrite: boolean;
  /** The `?block=` deep link: the H2 block to scroll to and flash. */
  blockId: string | null;
  openNode: (id: string, blockId: string | null) => void;
  /** The server's node after a body-owned write — the panel folds it in. */
  onWritten: (node: KnowledgeNode) => void;
  /** Someone else wrote first; the panel reloads and shows the banner. */
  onConflict: () => void;
  /** The panel's guarded, optimistic PATCH — for bodies that edit `data` directly. */
  patchNode: (patch: Partial<KnowledgeNode>) => Promise<void>;
  /** A panel-owned write is in flight; bodies disable their own controls. */
  saving: boolean;
}

const BODIES: Record<PanelBody, (props: PanelBodyProps) => React.ReactNode> = {
  markdown: (props) => <PanelProse {...props} />,
  work: (props) => <WorkBody {...props} />,
  goal: (props) => <GoalBody {...props} />,
  meeting: (props) => <MeetingBody {...props} />,
  entity: (props) => <EntityBody {...props} />,
  skill: ({ payload, workspace, canWrite, onWritten }) => (
    <SkillNodeView
      workspace={workspace}
      nodeId={payload.node.id}
      initialMarkdown={payload.node.content_md}
      initialData={payload.node.data}
      initialUpdatedAt={payload.node.updated_at}
      canWrite={canWrite}
      onWritten={onWritten}
      compact
    />
  ),
  data: ({ payload, workspace, canWrite, onWritten, onConflict }) => (
    <DataNodeView
      workspace={workspace}
      nodeId={payload.node.id}
      initialMarkdown={payload.node.content_md}
      initialData={payload.node.data}
      initialUpdatedAt={payload.node.updated_at}
      canWrite={canWrite}
      onWritten={onWritten}
      onConflict={onConflict}
      compact
    />
  ),
  credential: ({ payload, workspace, canWrite, onWritten }) => (
    <CredentialNodeView
      workspace={workspace}
      nodeId={payload.node.id}
      initialData={payload.node.data}
      initialUpdatedAt={payload.node.updated_at}
      canWrite={canWrite}
      onWritten={onWritten}
      compact
    />
  ),
};

export function PanelBodyForKind(props: PanelBodyProps) {
  const plan = panelPlanFor(props.payload.node.kind);
  return <>{BODIES[plan.body](props)}</>;
}
