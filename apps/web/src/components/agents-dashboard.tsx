"use client";

import { AgentConnectionsTab } from "./agent-connections-tab";
import { ToolProvidersView } from "./tools/tool-providers-view";
import { ConflictsView } from "./conflicts/conflicts-view";
import { type WorkspaceAddress } from "@/web/workspace-url";

/**
 * The three admin surfaces that render under `v/<slug>` as system views:
 * `agents` (connected agents, with Add agent), `tools` (tool providers +
 * webhooks) and `conflicts` (what NEXO is not sure about). Integrations have
 * no view of their own: they are connected to a Nexo, and the retired
 * `ingest`/`integrations` slugs redirect to the general Nexo in
 * `v/[view]/page.tsx`, as does `review` to Conflicts.
 */
export type WorkspaceAdminSurface = "agents" | "tools" | "conflicts";

/** Mounted by `v/[view]/page.tsx` for the admin slugs; the shell's header owns the title. */
export function WorkspaceAdminPage({ workspace, surface }: { workspace: WorkspaceAddress; surface: WorkspaceAdminSurface }) {
  return (
    <div className="scroll h-full overflow-y-auto bg-[var(--paper)]">
      <div className="mx-auto max-w-[1080px] px-5 pb-20 pt-9 sm:px-8 xl:px-12">
        {/* Title lives in the shell's content header. Endpoint setup, client
            config snippets and token creation live inside the Add agent
            modal (add-agent-modal.tsx), not on the agents page. */}
        {surface === "agents" && <AgentConnectionsTab workspace={workspace} />}
        {surface === "tools" && <ToolProvidersView workspace={workspace} />}
        {surface === "conflicts" && <ConflictsView workspace={workspace} />}
      </div>
    </div>
  );
}
