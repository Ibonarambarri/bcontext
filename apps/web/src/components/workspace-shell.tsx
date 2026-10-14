"use client";

/**
 * The chrome around every `/w/<org>/<ws>/**` page, mounted by that route's
 * `layout.tsx` (a Server Component that fetches the workspace, its siblings
 * and the node list through the API and passes them in as props).
 *
 * Provider order matters and is fixed here:
 *   WorkspaceRealtimeProvider — the workspace's WebSocket + presence
 *   └ WorkspaceProvider       — nodes, views, selection, toasts (`useWorkspace`)
 *     └ NexoProvider          — the chat's open state and width
 *       └ ShellBody           — sidebar · header row · active view · overlays
 *
 * The context must sit below realtime because it broadcasts and subscribes;
 * Nexo sits below the context because it opens nodes through it. Everything
 * heavy that is not visible on first paint (command palette, Nexo, node
 * panel, settings, create dialog) is a `next/dynamic` import.
 */

import dynamic from "next/dynamic";
import { WorkspaceProvider, useWorkspace, type CurrentUser } from "./workspace-context";
import { Sidebar, activeViewMeta, useSidebarWidth } from "./sidebar";
import { NexoProvider, useNexo } from "./nexo/nexo-provider";
import { Breadcrumbs } from "@heroui/react";
import { Sidebar as SidebarShell } from "@/components/ui/sidebar";
import { RecordMeetingShortcut } from "./agents/record-meeting-shortcut";
import { ToastViewport } from "./toast";
import { WorkspaceRealtimeProvider } from "@/lib/collab/workspace-realtime";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { ViewHeaderSlotProvider, useViewHeaderSlotTarget } from "./view-header-slot";
import { FloatingPanelRootProvider, useFloatingPanelRootTarget } from "./floating-panel";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { WorkspaceCard } from "@bcontext-dev/contract/workspaces";

const CommandPalette = dynamic(() => import("./command-palette").then((m) => m.CommandPalette));
// The launcher is a button; the panel behind it drags the whole markdown /
// streaming stack (the chat components → streamdown/remark), so it loads on the
// first open and never lands in the shell's synchronous chunk group.
const NexoLauncher = dynamic(() => import("./nexo/nexo-launcher").then((m) => m.NexoLauncher));
const CreateNodeDialogHost = dynamic(() => import("./create-node-dialog-host").then((m) => m.CreateNodeDialogHost));
const SettingsDialog = dynamic(() => import("./settings-dialog").then((m) => m.SettingsDialog));
const NodeFloatingPanel = dynamic(() => import("./node-floating-panel").then((m) => m.NodeFloatingPanel));
// The guide asks the API whether it is wanted before it shows anything, so
// nothing about it belongs in the first paint. If an element of the sidebar
// it rings moves or is renamed, the tour moves with it: `onboarding/steps.ts`.
const GettingStarted = dynamic(() => import("./onboarding/getting-started").then((m) => m.GettingStarted));

/** Air between Nexo and the node panel when both are open, in px. */
const NEXO_GUTTER = 12;

export function WorkspaceShell({
  org,
  workspaceSlug,
  workspace,
  workspaces,
  orgLayer,
  nodes,
  currentUser,
  children,
}: {
  org: string;
  workspaceSlug: string;
  workspace: WorkspaceCard | null;
  workspaces: WorkspaceCard[];
  /** Is the organization level worth showing? See `@/lib/org-layer`. */
  orgLayer: boolean;
  nodes: KnowledgeNode[];
  currentUser: CurrentUser;
  children: React.ReactNode;
}) {
  return (
    <WorkspaceRealtimeProvider
      workspaceId={workspace?.id ?? null}
      userId={currentUser.id}
      name={currentUser.name}
      color={currentUser.color}
      initialPageId={null}
    >
      <WorkspaceProvider
        org={org}
        workspaceSlug={workspaceSlug}
        workspace={workspace}
        workspaces={workspaces}
        orgLayer={orgLayer}
        nodes={nodes}
        currentUser={currentUser}
      >
        <NexoProvider>
          <ShellBody>{children}</ShellBody>
        </NexoProvider>
      </WorkspaceProvider>
    </WorkspaceRealtimeProvider>
  );
}

/**
 * The actual chrome. Lives inside the providers so it can read layout state.
 *
 * Desktop: sidebar (offcanvas, resizable) · a 12-unit header row with the
 * sidebar trigger, the active view's title and the view's own header slot ·
 * the active surface, with the floating node panel and Nexo over it.
 * Mobile (<768px): the surface takes the full width; the same trigger opens
 * the `Sidebar.Mobile` drawer instead of the aside. `zoom-viewport-h`
 * (dvh-based) keeps the layout correct under the iOS URL bar.
 */
function ShellBody({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  const {
    address,
    sidebarOpen,
    toggleSidebar,
    activeViewSlug,
    views,
  } = useWorkspace();
  const { open: nexoOpen, width: nexoWidth } = useNexo();

  const viewMeta = activeViewMeta(activeViewSlug, views);
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  // Controls the active view portals next to its title — see view-header-slot.tsx.
  const [headerSlot, setHeaderSlot] = useViewHeaderSlotTarget();
  // The active-page region, published so a view living inside a scroll
  // container can float a panel over the whole surface (the conflict panel).
  const [floatingRoot, setFloatingRoot] = useFloatingPanelRootTarget();

  return (
    <div className="field-shell zoom-viewport-h flex w-full flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <div className="relative flex min-h-0 flex-1">
        {/* One Sidebar shell for every breakpoint: the aside hides under
            768px (ui/sidebar.css) and the same Trigger opens the mobile
            drawer (Sidebar.Mobile) instead. */}
        <SidebarShell.Provider
          collapsible="offcanvas"
          open={sidebarOpen}
          onOpenChange={(next) => { if (next !== sidebarOpen) toggleSidebar(); }}
          toggleShortcut={false}
          className="min-h-0 w-full flex-1"
          style={{ "--sidebar-width": `${sidebarWidth}px`, "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
        >
          <Sidebar width={sidebarWidth} onResize={setSidebarWidth} />
          <SidebarShell.Main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-transparent">
            <div className="flex h-12 shrink-0 items-center gap-1.5 px-3 [padding-top:max(0px,env(safe-area-inset-top))]">
              <SidebarShell.Trigger />
              {viewMeta ? (
                viewMeta.section ? (
                  /* Route-style title for grouped views: Section / View. */
                  <Breadcrumbs className="text-[13.5px]">
                    <Breadcrumbs.Item className="text-muted">
                      <span className="flex items-center gap-2">{viewMeta.section}</span>
                    </Breadcrumbs.Item>
                    <Breadcrumbs.Item className="font-medium text-foreground">
                      <span className="flex items-center gap-2">
                        <viewMeta.Icon size={15} className="shrink-0" />
                        {viewMeta.label}
                      </span>
                    </Breadcrumbs.Item>
                  </Breadcrumbs>
                ) : (
                  <span className="flex items-center gap-2 text-[13.5px] font-medium text-foreground">
                    <viewMeta.Icon size={15} />
                    {viewMeta.label}
                  </span>
                )
              ) : null}
              <div ref={setHeaderSlot} className="ml-1 flex min-w-0 items-center" />
            </div>
            {/* The active view, with the floating node panel over it: half of
                this surface by default, all of it when expanded, never a
                modal — the view underneath stays live (the graph re-centers
                the open node in the free half).

                `--nexo-w` is how the two floating windows share this surface.
                It is not Nexo's width but the space it claims on the right:
                its width plus a gutter, so the node panel stops beside it with
                air between the two instead of edge to edge. Zero when Nexo is
                closed, and the panel returns to the full edge. */}
            <div
              ref={setFloatingRoot}
              role="region"
              aria-label="Active page"
              className="relative min-h-0 flex-1 overflow-hidden"
              style={
                {
                  "--nexo-w":
                    nexoOpen && !isMobile ? `${nexoWidth + NEXO_GUTTER}px` : "0px",
                } as React.CSSProperties
              }
            >
              <ViewHeaderSlotProvider target={headerSlot}>
                <FloatingPanelRootProvider root={floatingRoot}>{children}</FloatingPanelRootProvider>
              </ViewHeaderSlotProvider>
              <NodeFloatingPanel />
              <NexoLauncher />
              <GettingStarted />
            </div>
          </SidebarShell.Main>
        </SidebarShell.Provider>
      </div>
      <CommandPalette />
      <CreateNodeDialogHost workspace={address} />
      <RecordMeetingShortcut workspace={address} />
      <SettingsDialog />
      <ToastBridge />
    </div>
  );
}

/** Reads the context's toast queue and hands it to the presentational viewport. */
function ToastBridge() {
  const { toasts, toast } = useWorkspace();
  return <ToastViewport toasts={toasts} onDismiss={toast.dismiss} />;
}
