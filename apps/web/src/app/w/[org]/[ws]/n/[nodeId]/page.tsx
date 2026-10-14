/**
 * One node at `/w/<org>/<ws>/n/<id>`: the canonical node page.
 *
 * Server Component that reads the node and the workspace index through
 * `@/web/workspace`, then picks the body by kind — meeting, data, credential
 * and skill have their own views, everything else is the editor. The status
 * strip follows the same plan the floating panel uses
 * (`node-panel/body-for-kind.ts`), so a bug or a decision reads the same on
 * its page as in the panel. The body components are
 * lazy so the page's server render stays light; `?highlight=`, `?block=` and
 * `?view=` are deep-link hints (a RAG citation, an inspector block, the
 * meeting tab) rather than state.
 */
import { notFound } from "next/navigation";
import { AutofixButton } from "@/components/autofix-button";
import { resolveDefaultView, type MeetingView } from "@/lib/meetings/view";
import { TaskInspector } from "@/components/task-inspector";
import { MentionsEditor } from "@/components/mentions-editor";
import { parseCitationHighlight } from "@bcontext-dev/contract/rag/citation";
import type { RefineStatus } from "@bcontext-dev/contract/meetings";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { log } from "@bcontext-dev/contract/log";
import { getNode, listNodeSummaries } from "@/web/workspace";
import { workspaceName, type WorkspaceAddress } from "@/web/workspace-url";
import { TagPicker } from "@/components/tag-picker";
import { ActiveNodeInspector } from "@/components/active-node-inspector";
import { NodeBacklinks } from "@/components/node-backlinks";
import {
  LazyCredentialNodeView,
  LazyDataNodeView,
  LazyEditor,
  LazyGoalOverview,
  LazyMeetingNodeView,
  LazySkillNodeView,
  LazySubtasksSection,
} from "@/components/lazy-node-body";
import { panelPlanFor } from "@/components/node-panel/body-for-kind";

export default async function NodePage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; ws: string; nodeId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, ws, nodeId } = await params;
  const workspace: WorkspaceAddress = { org, slug: ws };
  const sp = (await searchParams) ?? {};
  const highlightChunk = parseCitationHighlight(sp.highlight);
  const inspectorBlock = typeof sp.block === "string" ? sp.block : null;
  let node: KnowledgeNode | null, all: KnowledgeNode[] | null;
  try {
    // Node fetch and tree fetch are independent — run concurrently. The tree
    // is the layout's request-scoped fetch, reused with no extra round-trip.
    // Both come back null for what this person cannot see: the API's 404,
    // turned into the page's after the catch so it is never logged as a
    // failure.
    [node, all] = await Promise.all([getNode(workspace, nodeId), listNodeSummaries(workspace)]);
  } catch (err) {
    log.error("node_page.fetch_failed", {
      ws: workspaceName(workspace),
      nodeId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 600) : null,
    });
    throw err;
  }
  if (!node || !all) notFound();
  const meetingData =
    node.kind === "meeting"
      ? ((node.data ?? {}) as {
          transcript_md?: string;
          refine_status?: RefineStatus;
          refine_error?: string | null;
          recording_status?: string | null;
          meeting_url?: string;
        })
      : null;
  const transcriptMd = meetingData?.transcript_md ?? "";
  const refineStatus = meetingData?.refine_status;
  const recordingStatus = meetingData?.recording_status ?? null;
  const recordingMeetingUrl = meetingData?.meeting_url ?? null;
  const hasTranscript = Boolean(meetingData && transcriptMd.trim().length > 0);
  const initialView: MeetingView = (() => {
    const requested = typeof sp.view === "string" ? sp.view : null;
    if (requested === "transcript" || requested === "refined") {
      return requested;
    }
    return resolveDefaultView(refineStatus, hasTranscript);
  })();

  const header = (
    <NodeHeader
      workspace={workspace}
      title={node.title}
      node={node}
      allNodes={all}
    />
  );

  const body =
    node.kind === "meeting" ? (
      <LazyMeetingNodeView
        workspace={workspace}
        nodeId={node.id}
        nodeTitle={node.title}
        initialMarkdown={node.content_md}
        transcriptMd={transcriptMd}
        refineStatus={refineStatus}
        refineError={meetingData?.refine_error ?? null}
        recordingStatus={recordingStatus}
        recordingMeetingUrl={recordingMeetingUrl}
        initialView={initialView}
        header={header}
      />
    ) : node.kind === "data" ? (
      <LazyDataNodeView
        workspace={workspace}
        nodeId={node.id}
        initialMarkdown={node.content_md}
        initialData={node.data}
        initialUpdatedAt={node.updated_at}
        header={header}
      />
    ) : node.kind === "credential" ? (
      <LazyCredentialNodeView
        workspace={workspace}
        nodeId={node.id}
        nodeTitle={node.title}
        initialData={node.data}
        initialUpdatedAt={node.updated_at}
        header={header}
      />
    ) : node.kind === "skill" ? (
      // A skill's body is source (YAML frontmatter + prompt): the rich
      // editor's Markdown round trip would flatten the schema, so it is
      // edited as text.
      <LazySkillNodeView
        workspace={workspace}
        nodeId={node.id}
        nodeTitle={node.title}
        initialMarkdown={node.content_md}
        initialData={node.data}
        initialUpdatedAt={node.updated_at}
        header={header}
      />
    ) : (
      <LazyEditor
        workspace={workspace}
        nodeId={node.id}
        nodeTitle={node.title}
        initialMarkdown={node.content_md}
        highlightChunk={highlightChunk}
        initialBlockId={inspectorBlock}
        header={header}
      />
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ActiveNodeInspector />
      <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
    </div>
  );
}

function NodeHeader({
  workspace,
  title,
  node,
  allNodes,
}: {
  workspace: WorkspaceAddress;
  title: string;
  node: KnowledgeNode;
  allNodes: KnowledgeNode[];
}) {
  const plan = panelPlanFor(node.kind);
  // Autofix rewrites the editor's body; kinds whose body is not the editor
  // (a grid, secret fields, a skill's source) have nothing for it to do.
  const hasEditor = node.kind !== "data" && node.kind !== "credential" && node.kind !== "skill";
  return (
    <div className="mb-6 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h1 className="fld-title text-[26px]">{title}</h1>
        {hasEditor ? (
          <div className="opacity-70 transition-opacity hover:opacity-100">
            <AutofixButton />
          </div>
        ) : null}
      </div>
      {plan.status === "task" ? <TaskInspector node={node} showPriority={plan.priority} /> : null}
      {/* A goal states what it is before it argues for itself: scope, health,
          horizon and the key results its progress is computed from. The body
          below stays the editor — unlike a credential, a goal has prose worth
          writing. */}
      {node.kind === "goal" ? <LazyGoalOverview node={node} editable className="mt-3" /> : null}
      <TagPicker node={node} workspace={workspace} />
      <NodeBacklinks nodeId={node.id} workspace={workspace} />
      <MentionsEditor node={node} workspace={workspace} allNodes={allNodes} />
      {node.kind === "task" || node.kind === "bug" ? (
        // The steps, above the body: on the page the body is the editor,
        // which owns its own save path; the subtasks write through the
        // API's guarded op and never touch content_md.
        <LazySubtasksSection workspace={workspace} node={node} canWrite className="mt-4" />
      ) : null}
    </div>
  );
}
