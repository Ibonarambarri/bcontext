"use client";

/**
 * The prose part of a panel body: the node's Markdown, editable in place.
 * With write access it is the real editor — the same TipTap/Yjs chunk the
 * `/n/<id>` page mounts, as its `panel` variant, so two people editing the
 * same node from a board and from the page share one Yjs room and one
 * save path (`PATCH content_md`, debounced, markdown as the truth). The
 * chunk stays lazy (`LazyPanelEditor`) so the workspace shell never pays
 * for it. Read-only access keeps the rendered Markdown, whose H2 blocks
 * carry the `data-inspector-block` anchors the `?block=` highlight uses;
 * the editor resolves the same deep link itself (`initialBlockId`).
 *
 * The editor is keyed by node id: moving the panel to another node must
 * not carry over save state, autofix review or the previous room.
 */

import { LazyPanelEditor } from "@/components/lazy-node-body";
import { NodeMarkdown } from "@/components/node-markdown";
import type { PanelBodyProps } from "./panel-body";

export function PanelProse({ payload, workspace, canWrite, blockId, openNode, onWritten }: PanelBodyProps) {
  const node = payload.node;
  if (!canWrite) {
    return (
      <NodeMarkdown
        markdown={node.content_md}
        activeBlockId={blockId}
        onOpenNode={openNode}
      />
    );
  }
  return (
    <LazyPanelEditor
      key={node.id}
      workspace={workspace}
      nodeId={node.id}
      nodeTitle={node.title}
      initialMarkdown={node.content_md}
      initialBlockId={blockId}
      onSaved={onWritten}
    />
  );
}
