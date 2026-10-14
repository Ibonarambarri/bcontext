"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { ContextConnections } from "@/components/context-lens";
import type { Backlink } from "@bcontext-dev/contract/backlinks";
import { workspacePath, workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

/**
 * Compact backlinks list for the `/n/<id>` node page header — fetches the
 * same `/inspector` payload the floating node panel uses and keeps only
 * backlinks + forward links, so the page needs no route of its own. Rows
 * navigate to the other node's page (this surface is a page, not the panel).
 */
export function NodeBacklinks({
  nodeId,
  workspace,
}: {
  nodeId: string;
  workspace: WorkspaceAddress;
}) {
  const router = useRouter();
  const [data, setData] = useState<{
    backlinks: Backlink[];
    forward_links: Backlink[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetch(
      `/api/nodes/${encodeURIComponent(nodeId)}/inspector?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`,
      { cache: "no-store" },
    )
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body: { backlinks?: Backlink[]; forward_links?: Backlink[] }) => {
        if (cancelled) return;
        setData({
          backlinks: body.backlinks ?? [],
          forward_links: body.forward_links ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) setData({ backlinks: [], forward_links: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, workspace]);

  if (!data) return null;

  return (
    <div className="mt-3">
      <ContextConnections
        backlinks={data.backlinks}
        forwardLinks={data.forward_links}
        workspace={workspace}
        onOpen={(id, blockId) =>
          router.push(`${workspacePath(workspace, `n/${id}`)}${blockId ? `#${blockId}` : ""}` as Route)
        }
      />
    </div>
  );
}
