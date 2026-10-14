"use client";

/**
 * The workspace's primary navigation, mounted by `workspace-shell.tsx`
 * inside the `Sidebar.Provider` of `ui/sidebar` (offcanvas on desktop, the
 * `Sidebar.Mobile` drawer under 768px — one tree of content rendered twice).
 *
 * Structure: workspace switcher · Find (⌘K) · Dashboard, Nexos (with the
 * open-inbox count polled from `/api/nexos/inbox`) and Conflicts (open count
 * polled from `/api/nexo/conflicts`) · the Knowledge group (Brain first, then
 * Tasks, Roadmap, Browse, Credentials, and "New" last: the create-node
 * dialog, ⌘⇧K, dispatched as the `bcontext:new-node` window event that
 * `create-node-dialog-host.tsx` listens for — it sits with the knowledge it
 * creates, not with Find) · the Agents & Tools group (connected agents and
 * tool providers) · the account row (user menu).
 *
 * Integrations have no entry of their own: an integration is connected to a
 * Nexo, from the Nexos page.
 *
 * What is deliberately NOT here: saved custom views (their routes still
 * render for direct links), Activity (in the user menu), Tags and Decisions
 * as entries of their own. Tags are a focus inside Brain (`graph-view.tsx`),
 * which is also where tags are created and managed; a second graph surface
 * over the same data starved the thin one.
 *
 * `activeViewMeta` is the sidebar's knowledge of slugs turned into the
 * title the shell shows next to the trigger. Width is user-resizable and
 * kept in localStorage (`useSidebarWidth`, owned by the shell).
 */

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  Activity,
  Bookmark,
  Bot,
  BrainCircuit,
  CheckSquare,
  Folder,
  Home,
  KeyRound,
  LayoutGrid,
  List,
  Milestone,
  Network,
  Plus,
  Search,
  ShieldQuestion,
  Table2,
  Wrench,
} from "lucide-react";
import { Button, Kbd } from "@heroui/react";
import { Sidebar as SidebarPrimitive, useSidebar } from "@/components/ui/sidebar";
import { nexosPath, systemViewPath, type SystemViewKey } from "@/lib/view-shell";
import { NexosMark } from "./nexos/nexos-mark";
import type { SavedView } from "@bcontext-dev/contract/views/types";
import type { ViewRenderer } from "@bcontext-dev/contract/views/schema";
import { useWorkspace } from "./workspace-context";
import { UserMenu } from "./user-menu";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { OPEN_GUIDE_EVENT } from "./onboarding/events";
import { workspaceApiRef } from "@/web/workspace-url";

/** The Knowledge group, in display order. Brain first: it is the workspace. */
const KNOWLEDGE_VIEWS: { key: SystemViewKey; label: string; Icon: typeof Home }[] = [
  { key: "graph", label: "Brain", Icon: BrainCircuit },
  { key: "tasks", label: "Tasks", Icon: CheckSquare },
  { key: "roadmap", label: "Roadmap", Icon: Milestone },
  { key: "browse", label: "Browse", Icon: Folder },
  { key: "credentials", label: "Credentials", Icon: KeyRound },
];

const VIEW_RENDERER_ICONS: Record<ViewRenderer, typeof Home> = {
  graph: Network,
  board: LayoutGrid,
  table: Table2,
  list: List,
  changes: Activity,
  browse: Folder,
  credentials: KeyRound,
  roadmap: Milestone,
};

const ADMIN_VIEWS: { key: SystemViewKey; label: string; Icon: typeof Bot }[] = [
  { key: "agents", label: "Agents", Icon: Bot },
  { key: "tools", label: "Tools", Icon: Wrench },
];

const BADGE_POLL_MS = 60_000;

/**
 * An open-item count for a sidebar badge, polled once a minute; null until
 * known or when the read fails (the badge simply stays hidden). `url` null
 * means there is nothing to ask yet (no persisted workspace).
 */
function usePolledCount(url: string | null, field: string): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!url) {
      setCount(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) return;
        const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        const list = body[field];
        if (!cancelled) setCount(Array.isArray(list) ? list.length : null);
      } catch {
        // Badge simply stays hidden.
      }
    };
    void load();
    const timer = setInterval(() => void load(), BADGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, field]);
  return count;
}

/** The small count chip at the end of a menu row; nothing when there is nothing open. */
function CountChip({ count, label }: { count: number | null; label: string }) {
  if (!count) return null;
  return (
    <SidebarPrimitive.MenuChip aria-label={`${count} ${label}`} className="tabular-nums">
      {count > 99 ? "99+" : count}
    </SidebarPrimitive.MenuChip>
  );
}

/**
 * A nav icon is anything that draws itself at a size — the lucide set, and
 * the Nexos team mark, a plain SVG kept dependency-free for the shell budget.
 */
export type NavIcon = ComponentType<{ size?: number; className?: string }>;

/**
 * Icon + label (+ section) for the active view — the shell's header row
 * shows it next to the sidebar trigger. Null for a slug the sidebar does
 * not know, in which case the shell shows no title.
 */
export function activeViewMeta(
  slug: string | null,
  views: SavedView[],
): { label: string; Icon: NavIcon; section?: string } | null {
  if (!slug) return null;
  if (slug === "overview") return { label: "Dashboard", Icon: Home };
  if (slug === "nexos") return { label: "Nexos", Icon: NexosMark };
  if (slug === "changes") return { label: "Activity", Icon: Activity };
  // `review` is a legacy slug that redirects (see v/[view]/page.tsx); label it for the frame it passes through.
  if (slug === "conflicts" || slug === "review") return { label: "Conflicts", Icon: ShieldQuestion };
  const knowledge = KNOWLEDGE_VIEWS.find((view) => view.key === slug);
  if (knowledge) return { label: knowledge.label, Icon: knowledge.Icon, section: "Knowledge" };
  const admin = ADMIN_VIEWS.find((view) => view.key === slug);
  if (admin) return { label: admin.label, Icon: admin.Icon, section: "Agents & Tools" };
  const custom = views.find((view) => view.slug === slug);
  if (custom) return { label: custom.name, Icon: VIEW_RENDERER_ICONS[custom.presentation.renderer] ?? Bookmark, section: "Knowledge" };
  return null;
}

// Sidebar width is user-resizable (drag the right edge) and persisted locally.
const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 400;
const SIDEBAR_DEFAULT_W = 320;
const SIDEBAR_WIDTH_KEY = "bcontext:sidebar-width";

function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, Math.round(value)));
}

/**
 * The sidebar's width as state + setter, read from localStorage after mount
 * (SSR renders the default so the markup matches). The shell owns it and
 * feeds it to both the CSS variable and the resize handle.
 */
export function useSidebarWidth(): [number, (next: number) => void] {
  const [width, setWidth] = useState(SIDEBAR_DEFAULT_W);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
      const parsed = raw != null ? Number(JSON.parse(raw)) : NaN;
      if (Number.isFinite(parsed)) setWidth(clampSidebarWidth(parsed));
    } catch {
      /* ignore malformed or unavailable storage */
    }
  }, []);
  const update = useCallback((next: number) => {
    const clamped = clampSidebarWidth(next);
    setWidth(clamped);
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, JSON.stringify(clamped));
    } catch {
      /* ignore quota or unavailable storage */
    }
  }, []);
  return [width, update];
}

export function Sidebar({
  width,
  onResize,
}: { width?: number; onResize?: (next: number) => void } = {}) {
  const {
    address,
    activeViewSlug,
    workspace,
    openSettings,
  } = useWorkspace();
  const router = useRouter();
  const { setMobileOpen } = useSidebar();
  const workspaceId = workspace?.id ?? null;
  const openConflicts = usePolledCount(
    workspaceId ? `/api/nexo/conflicts?workspace_id=${encodeURIComponent(workspaceId)}&status=open` : null,
    "conflicts",
  );
  const openInbox = usePolledCount(
    workspaceId ? `/api/nexos/inbox?workspace=${encodeURIComponent(workspaceApiRef(address))}&status=open` : null,
    "items",
  );
  // Width state lives in the shell (the offcanvas wrapper reads
  // --sidebar-width at the Provider level); props arrive on desktop only.
  const sidebarWidth = width ?? SIDEBAR_DEFAULT_W;
  const setSidebarWidth = onResize ?? (() => {});

  const navigate = useCallback((href: Route) => {
    router.push(href);
  }, [router]);

  // The mobile sheet closes itself only for items with an href; an action
  // item has to close it, or the dialog opens behind the sheet.
  const openNewNode = useCallback(() => {
    setMobileOpen(false);
    window.dispatchEvent(new CustomEvent("bcontext:new-node"));
  }, [setMobileOpen]);

  // Rendered twice under the shell's Sidebar.Provider: in the desktop aside
  // (offcanvas collapse, Trigger in the content header) and in the phone
  // drawer that the same Trigger opens.
  const sidebarInner = (
        <>
          <SidebarPrimitive.Header>
            <div className="flex min-h-12 items-center gap-1 px-2 py-1.5 [padding-top:max(0.375rem,env(safe-area-inset-top))]">
              <WorkspaceSwitcher />
            </div>
          </SidebarPrimitive.Header>

          <SidebarPrimitive.Content>
            <nav aria-label="Primary workspace navigation" className="scroll flex-1 overflow-y-auto px-1 pb-3">
              <Button
                variant="ghost"
                fullWidth
                className="justify-start gap-2"
                onPress={() => window.dispatchEvent(new CustomEvent("bcontext:open-command-palette"))}
              >
                <Search size={13} />
                Find
                <Kbd className="ml-auto">
                  <Kbd.Abbr keyValue="command" />
                  <Kbd.Content>K</Kbd.Content>
                </Kbd>
              </Button>

              <SidebarPrimitive.Group className="mt-1">
                <SidebarPrimitive.Menu aria-label="Workspace">
                  <SidebarPrimitive.MenuItem
                    id="overview"
                    aria-label="Dashboard"
                    href={systemViewPath(address, "overview")}
                    isCurrent={activeViewSlug === "overview"}
                  >
                    <SidebarPrimitive.MenuIcon><Home size={13} /></SidebarPrimitive.MenuIcon>
                    <SidebarPrimitive.MenuItemContent>
                      <SidebarPrimitive.MenuLabel>Dashboard</SidebarPrimitive.MenuLabel>
                    </SidebarPrimitive.MenuItemContent>
                  </SidebarPrimitive.MenuItem>
                  <SidebarPrimitive.MenuItem
                    id="nexos"
                    aria-label="Nexos"
                    href={nexosPath(address)}
                    isCurrent={activeViewSlug === "nexos"}
                  >
                    <SidebarPrimitive.MenuIcon><NexosMark /></SidebarPrimitive.MenuIcon>
                    <SidebarPrimitive.MenuItemContent>
                      <SidebarPrimitive.MenuLabel>Nexos</SidebarPrimitive.MenuLabel>
                    </SidebarPrimitive.MenuItemContent>
                    <CountChip count={openInbox} label="items waiting in the Nexos' inbox" />
                  </SidebarPrimitive.MenuItem>
                  <SidebarPrimitive.MenuItem
                    id="conflicts"
                    aria-label="Conflicts"
                    href={systemViewPath(address, "conflicts")}
                    isCurrent={activeViewSlug === "conflicts"}
                  >
                    <SidebarPrimitive.MenuIcon><ShieldQuestion size={13} /></SidebarPrimitive.MenuIcon>
                    <SidebarPrimitive.MenuItemContent>
                      <SidebarPrimitive.MenuLabel>Conflicts</SidebarPrimitive.MenuLabel>
                    </SidebarPrimitive.MenuItemContent>
                    <CountChip count={openConflicts} label="open conflicts" />
                  </SidebarPrimitive.MenuItem>
                </SidebarPrimitive.Menu>
              </SidebarPrimitive.Group>

              <SidebarPrimitive.Group className="mt-4">
                <SidebarPrimitive.GroupLabel>Knowledge</SidebarPrimitive.GroupLabel>
                <SidebarPrimitive.Menu aria-label="Knowledge">
                  {KNOWLEDGE_VIEWS.map(({ key, label, Icon }) => (
                    <SidebarPrimitive.MenuItem key={key} id={key} href={systemViewPath(address, key)} isCurrent={activeViewSlug === key}>
                      <SidebarPrimitive.MenuIcon><Icon size={13} /></SidebarPrimitive.MenuIcon>
                      <SidebarPrimitive.MenuItemContent>
                        <SidebarPrimitive.MenuLabel>{label}</SidebarPrimitive.MenuLabel>
                      </SidebarPrimitive.MenuItemContent>
                    </SidebarPrimitive.MenuItem>
                  ))}
                  {/* Not a route: opens the create-node dialog, whose host
                      owns the ⌘⇧K binding the hint advertises. */}
                  <SidebarPrimitive.MenuItem
                    id="new-node"
                    textValue="New"
                    aria-label="New node"
                    aria-keyshortcuts="Meta+Shift+K"
                    onAction={openNewNode}
                  >
                    <SidebarPrimitive.MenuIcon><Plus size={13} /></SidebarPrimitive.MenuIcon>
                    <SidebarPrimitive.MenuItemContent>
                      <SidebarPrimitive.MenuLabel>New</SidebarPrimitive.MenuLabel>
                    </SidebarPrimitive.MenuItemContent>
                    <Kbd variant="light" className="ml-auto shrink-0 text-[10px] text-[var(--ink-mute)]">
                      <Kbd.Abbr keyValue="command" />
                      <Kbd.Abbr keyValue="shift" />
                      <Kbd.Content>K</Kbd.Content>
                    </Kbd>
                  </SidebarPrimitive.MenuItem>
                </SidebarPrimitive.Menu>
              </SidebarPrimitive.Group>

              <SidebarPrimitive.Group className="mt-4">
                <SidebarPrimitive.GroupLabel>Agents & Tools</SidebarPrimitive.GroupLabel>
                <SidebarPrimitive.Menu aria-label="Agents & Tools">
                  {ADMIN_VIEWS.map(({ key, label, Icon }) => (
                    <SidebarPrimitive.MenuItem key={key} id={key} href={systemViewPath(address, key)} isCurrent={activeViewSlug === key}>
                      <SidebarPrimitive.MenuIcon><Icon size={13} /></SidebarPrimitive.MenuIcon>
                      <SidebarPrimitive.MenuItemContent>
                        <SidebarPrimitive.MenuLabel>{label}</SidebarPrimitive.MenuLabel>
                      </SidebarPrimitive.MenuItemContent>
                    </SidebarPrimitive.MenuItem>
                  ))}
                </SidebarPrimitive.Menu>
              </SidebarPrimitive.Group>
            </nav>
          </SidebarPrimitive.Content>

          {/* Demo-pattern footer: the account row (avatar + name) opens the
              user dropdown. */}
          <SidebarPrimitive.Footer className="p-2">
            <UserMenu
              align="up"
              profileCard
              onOpenSettings={openSettings}
              onOpenActivity={() => navigate(systemViewPath(address, "changes"))}
              onOpenGuide={() => window.dispatchEvent(new CustomEvent(OPEN_GUIDE_EVENT))}
            />
          </SidebarPrimitive.Footer>
        </>
  );

  return (
    <>
    {/* Desktop aside — ui/sidebar.css hides it under 768px. */}
    <SidebarPrimitive className="relative h-full">
      {sidebarInner}
      <SidebarResizeHandle width={sidebarWidth} onResize={setSidebarWidth} />
    </SidebarPrimitive>
    {/* Mobile drawer, opened by the same Sidebar.Trigger. */}
    <SidebarPrimitive.Mobile>
      {sidebarInner}
    </SidebarPrimitive.Mobile>
    </>
  );
}

/** Accessible drag handle on the sidebar's right edge; resizes between SIDEBAR_MIN_W and SIDEBAR_MAX_W. */
function SidebarResizeHandle({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const { isOpen } = useSidebar();
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  // Listeners live for the component's lifetime and no-op unless a drag is in progress
  // (dragState.current is set on pointer down), which avoids re-subscribing mid-drag.
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragState.current) return;
      const delta = event.clientX - dragState.current.startX;
      onResizeRef.current(clampSidebarWidth(dragState.current.startWidth + delta));
    };
    const handlePointerUp = (event: PointerEvent) => {
      dragState.current = null;
      if (event.target instanceof Element && event.target.hasPointerCapture(event.pointerId)) {
        event.target.releasePointerCapture(event.pointerId);
      }
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragState.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 24 : 8;
    if (event.key === "ArrowLeft") { event.preventDefault(); onResize(width - step); }
    else if (event.key === "ArrowRight") { event.preventDefault(); onResize(width + step); }
    else if (event.key === "Home") { event.preventDefault(); onResize(SIDEBAR_MIN_W); }
    else if (event.key === "End") { event.preventDefault(); onResize(SIDEBAR_MAX_W); }
  };

  // Collapsed sidebar: no edge to drag — don't advertise a resize cursor.
  if (!isOpen) return null;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_W}
      aria-valuemax={SIDEBAR_MAX_W}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      className="group absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none outline-none"
    >
      <div className="mx-auto h-full w-px bg-transparent group-hover:bg-[var(--accent)] group-focus-visible:bg-[var(--accent)]" />
    </div>
  );
}
