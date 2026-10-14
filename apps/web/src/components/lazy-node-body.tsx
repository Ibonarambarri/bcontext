"use client";

/**
 * Client-only entry points for the node page's body (`n/[nodeId]/page.tsx`
 * is a Server Component and cannot call `next/dynamic` with `ssr: false`
 * itself) and for the floating node panel's bodies (`node-panel/*`), which
 * mount the same editor chunk through `LazyPanelEditor`. Every
 * kind-specific body — the TipTap/Yjs editor, meeting, data, credential,
 * goal, subtasks — loads as its own async chunk with a skeleton in its
 * place, so none of them lands in the route's initial chunks (the perf
 * budget in `scripts/check-performance-budgets.mjs`).
 *
 * The wrappers below exist only so the page imports plain components with
 * typed props; they add nothing else.
 */
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { EditorProps } from "@/components/editor";
import { NodePageSkeleton, PanelBodySkeleton } from "@/components/skeletons";
import type { MeetingView } from "@/lib/meetings/view";
import type { RefineStatus } from "@bcontext-dev/contract/meetings";
import { type WorkspaceAddress } from "@/web/workspace-url";

const Editor = dynamic(() => import("@/components/editor").then((m) => m.Editor), {
  ssr: false,
  loading: () => <NodePageSkeleton />,
});
// The same chunk, mounted by the floating node panel's bodies: the panel's
// header and strip are already on screen, so the placeholder is body-sized.
const PanelEditor = dynamic(() => import("@/components/editor").then((m) => m.Editor), {
  ssr: false,
  loading: () => <PanelBodySkeleton />,
});
const MeetingNodeView = dynamic(
  () => import("@/components/agents/meeting-node-view").then((m) => m.MeetingNodeView),
  { ssr: false, loading: () => <NodePageSkeleton /> },
);
const DataNodeView = dynamic(
  () => import("@/components/data-node-view").then((m) => m.DataNodeView),
  { ssr: false, loading: () => <NodePageSkeleton /> },
);
const CredentialNodeView = dynamic(
  () => import("@/components/credential-node-view").then((m) => m.CredentialNodeView),
  { ssr: false, loading: () => <NodePageSkeleton /> },
);
const SkillNodeView = dynamic(
  () => import("@/components/skill-node-view").then((m) => m.SkillNodeView),
  { ssr: false, loading: () => <NodePageSkeleton /> },
);
// Subtasks render Markdown (react-markdown + remark) for an opened step; on
// the page that would put the whole renderer in the route's initial chunks,
// which the perf budget rejects. The list paints once the chunk lands.
// A goal's panel is structured data, not prose — but it drags in Meter and
// Select, which the node route does not otherwise pay for. Async, like every
// other kind-specific body here.
const GoalOverview = dynamic(
  () => import("@/components/goal-node-view").then((m) => m.GoalOverview),
  { ssr: false, loading: () => null },
);
const SubtasksSection = dynamic(
  () => import("@/components/subtasks-section").then((m) => m.SubtasksSection),
  { ssr: false, loading: () => null },
);

export function LazyEditor(props: EditorProps) {
  return <Editor {...props} />;
}

/** The editor as the floating panel's body (`variant="panel"` is implied). */
export function LazyPanelEditor(props: Omit<EditorProps, "variant">) {
  return <PanelEditor {...props} variant="panel" />;
}

export function LazySubtasksSection(props: ComponentProps<typeof SubtasksSection>) {
  return <SubtasksSection {...props} />;
}

export function LazyGoalOverview(props: ComponentProps<typeof GoalOverview>) {
  return <GoalOverview {...props} />;
}

export function LazyDataNodeView(props: {
  workspace: WorkspaceAddress;
  nodeId: string;
  /** Only read to spot the ```csv block a legacy `data` node still carries. */
  initialMarkdown: string;
  /** `node.data`: the dataset's schema, so the table paints without a round-trip. */
  initialData?: Record<string, unknown>;
  initialUpdatedAt?: string;
  header?: React.ReactNode;
}) {
  return <DataNodeView {...props} />;
}

export function LazyCredentialNodeView(props: {
  workspace: WorkspaceAddress;
  nodeId: string;
  nodeTitle?: string;
  initialData: Record<string, unknown>;
  initialUpdatedAt?: string;
  header?: React.ReactNode;
}) {
  return <CredentialNodeView {...props} />;
}

export function LazySkillNodeView(props: {
  workspace: WorkspaceAddress;
  nodeId: string;
  nodeTitle?: string;
  initialMarkdown: string;
  initialData: Record<string, unknown>;
  initialUpdatedAt?: string;
  header?: React.ReactNode;
}) {
  return <SkillNodeView {...props} />;
}

export function LazyMeetingNodeView(props: {
  workspace: WorkspaceAddress;
  nodeId: string;
  nodeTitle: string;
  initialMarkdown: string;
  transcriptMd: string;
  refineStatus: RefineStatus | undefined;
  refineError: string | null;
  recordingStatus: string | null;
  recordingMeetingUrl: string | null;
  initialView: MeetingView;
  header: React.ReactNode;
}) {
  return <MeetingNodeView {...props} />;
}
