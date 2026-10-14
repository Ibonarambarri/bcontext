"use client";

/**
 * The workspace's client-side state, as one React context (`useWorkspace`),
 * provided by `workspace-shell.tsx` around every `/w/<org>/<ws>/**` page.
 * The web has no data of its own: `nodes` arrive from the layout (fetched
 * server-side through the API), and everything this file does is keep them
 * coherent with what the person and their peers are doing in between RSC
 * refreshes.
 *
 * What it owns, in order of appearance:
 *   - navigation preference (the last view opened) — localStorage per
 *     workspace;
 *   - views: `GET /api/views` once, `POST /api/views/:id/resolve` for the
 *     active view (`activeViewResult`/`activeViewGraph`), re-resolved on
 *     graph events (debounced) and `view.changed`;
 *   - the node overlay: `serverNodes` + `summaryPatches` + `tempNodes` →
 *     `nodes` (live) and `archivedNodes`. Patches are what optimistic
 *     writes and peers' `node.updated` broadcasts fold in; they win over
 *     the server row until the row's `updated_at` catches up, then prune;
 *   - toasts (`ToastApi`, with rapid-duplicate collapsing);
 *   - the sidebar flag (localStorage) and the editor's per-node scroll
 *     offsets (memory only);
 *   - node selection: ONE floating panel with a back/forward trail
 *     (`@/lib/node-selection`), mirrored into `?inspect=&block=` with
 *     replaceState so a node is deep-linkable without touching browser
 *     history; on a `/n/<id>` page selection navigates instead;
 *   - realtime: presence page id, and a debounced `router.refresh()` on
 *     tree-shape events (`node.created/renamed/deleted/moved`,
 *     `tree.invalidated`) — data-only events patch the overlay instead;
 *   - node CRUD (`createNode` with an optimistic temp node, `renameNode`,
 *     `deleteNode`, `duplicateNode`) that broadcasts to peers;
 *   - settings dialog flag and the ⌘B / ⌘W / ⌘, shortcuts.
 *
 * Invariants worth knowing before editing: every optimistic write must
 * either carry `updated_at` (so its patch prunes itself) or be reverted on
 * failure; `router.refresh()` is debounced and never called per event; and
 * the URL mirror uses `replaceState`, never `push`, so the browser's Back
 * stays the page's.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import type { Route } from "next";
import type {
  KnowledgeNode,
  NodeKind,
  Priority,
  NodeStatus,
  WorkspaceTag,
} from "@bcontext-dev/contract/types";
import type { WorkspaceCard } from "@bcontext-dev/contract/workspaces";
import {
  density as densityStore,
  nodePanelSizePreference,
  textScale as textScaleStore,
  workspaceNavigation,
} from "@/lib/local-settings";
import {
  canGoBack,
  canGoForward,
  currentNodeSelection,
  EMPTY_NODE_HISTORY,
  panelSizeFromLegacy,
  pushNodeHistory,
  stepNodeHistory,
  type NodeHistory,
  type NodePanelSize,
  type NodeSelection,
} from "@/lib/node-selection";
import { getSupabaseBrowserLazy } from "@/lib/supabase/browser-lazy";
import type { SavedView, ResolvedViewQuery } from "@bcontext-dev/contract/views/types";
import type { GraphSnapshot } from "@bcontext-dev/contract/graph/model";
import { GRAPH_REALTIME_EVENTS } from "@/lib/graph/realtime";
import {
  DEFAULT_WORKSPACE_NAVIGATION,
  fullNodeUrl,
  viewSlugFromPathname,
  type WorkspaceNavigationPreference,
} from "@/lib/view-shell";
import {
  useWorkspaceBroadcast,
  useWorkspaceRealtime,
} from "@/lib/collab/workspace-realtime";
import { workspacePath, workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";
import { supabaseAuthConfigured } from "@/lib/public-env";

/**
 * Identity passed to the live-collab provider so peers can paint each
 * other's cursors with a stable colour and a readable name. `id` is the
 * Supabase user id when signed in, or a random anonymous handle otherwise.
 */
export interface CurrentUser {
  id: string;
  email: string | null;
  name: string;
  color: string;
  anonymous: boolean;
}

export type ToastKind = "info" | "error";

/**
 * An optional button inside the toast. This is how a change announces itself
 * *and* offers the way back — "Nexo edited X · Undo" — instead of asking
 * first. Pressing it dismisses the toast.
 */
export interface ToastAction {
  label: string;
  onPress: () => void;
}

/** One queued notification; `createdAt` is bumped when a duplicate collapses into it. */
export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  duration?: number;
  createdAt: number;
  action?: ToastAction;
}

export interface ToastOptions {
  duration?: number;
  action?: ToastAction;
}

/** What components call: `toast.info(...)` / `toast.error(...)`, returning the toast id. */
export interface ToastApi {
  info: (message: string, opts?: ToastOptions) => string;
  error: (message: string, opts?: ToastOptions) => string;
  dismiss: (id: string) => void;
}

/** Everything `useWorkspace()` returns. Grouped as in the file header. */
interface WorkspaceCtx {
  /** Where this workspace lives: the `<org>/<workspace>` pair every URL and API call carries. */
  address: WorkspaceAddress;
  workspaceSlug: string;
  workspace: WorkspaceCard | null;
  workspaces: WorkspaceCard[];
  /**
   * Whether the interface names the organization at all. Derived once, on
   * the server, by `@/lib/org-layer`: false for one person with one
   * workspace, true the moment a second workspace or a second member exists.
   */
  orgLayer: boolean;
  nodes: KnowledgeNode[];
  /** Nodes with status `archived` — hidden from `nodes`, shown on the tasks board's shelf. */
  archivedNodes: KnowledgeNode[];
  currentUser: CurrentUser;

  views: SavedView[];
  viewsLoading: boolean;
  viewsError: string | null;
  activeView: SavedView | null;
  activeViewSlug: string;
  activeViewResult: ResolvedViewQuery | null;
  activeViewGraph: GraphSnapshot | null;
  refreshViews: () => Promise<void>;
  /** The node open in the floating panel (or on the `/n/<id>` route). */
  inspectedNodeId: string | null;
  inspectedBlockId: string | null;
  /** Default size of the floating panel — half of the active surface, or all of it. */
  nodePanelSize: NodePanelSize;
  setNodePanelSize: (size: NodePanelSize) => void;
  /**
   * Open a node in the floating panel (on the `/n/<id>` route: navigate to
   * that node's page instead, so a page stays a page). Re-selecting the open
   * node with another block just scrolls; `replace` is accepted for callers
   * that used to distinguish, and means the same.
   */
  selectNode: (id: string, options?: { blockId?: string | null; replace?: boolean }) => void;
  /** Close the panel (or leave the `/n/<id>` page back to where it came from). */
  closeNode: () => void;
  goBackNode: () => void;
  goForwardNode: () => void;
  canGoBackNode: boolean;
  canGoForwardNode: boolean;
  /** Escalate the open node (or `id`) to its full `/n/<id>` page. */
  openNodePage: (id?: string) => void;

  /** Desktop sidebar collapsed/expanded, persisted per workspace (⌘B). */
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  /** The node whose `/n/<id>` page is open; null on every view route. */
  activeNodeId: string | null;

  /** The editor's scroll position per node, so returning to a page lands where it was left. */
  getNodeScroll: (nodeId: string) => number;
  setNodeScroll: (nodeId: string, offset: number) => void;

  createNode: (input: {
    title: string;
    kind: NodeKind;
    parent_id?: string | null;
    content_md?: string;
    status?: NodeStatus | null;
    priority?: Priority | null;
    data?: Record<string, unknown>;
    tag_ids?: string[];
    /** Board creates remain in the current renderer instead of opening the node's page. */
    navigate?: boolean;
  }) => Promise<KnowledgeNode | null>;

  renameNode: (id: string, title: string) => Promise<boolean>;
  deleteNode: (id: string) => Promise<boolean>;
  duplicateNode: (id: string) => Promise<KnowledgeNode | null>;

  /**
   * Fold a server-confirmed (or optimistic) partial node into the local
   * overlay so every renderer converges instantly without a refetch or
   * router.refresh(). Include `updated_at` whenever available — it lets the
   * overlay auto-prune once server data catches up.
   */
  patchNodeSummary: (nodeId: string, summary: Partial<KnowledgeNode>) => void;

  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;

  toasts: Toast[];
  toast: ToastApi;
}

const Ctx = createContext<WorkspaceCtx | null>(null);

/** The workspace context; throws outside `WorkspaceProvider` (i.e. outside `/w/**`). */
export function useWorkspace() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace outside provider");
  return v;
}

/** The toast API alone, for components that need nothing else from the workspace. */
export function useToast(): ToastApi {
  return useWorkspace().toast;
}

/* Keyed by the `<org>~<workspace>` ref: two companies both get to have a
   `docs`, and their sidebars are not the same sidebar. */
function layoutKey(ref: string) {
  return `bcontext:${ref}:layout`;
}

/** See the file header for what this provides and the invariants it keeps. */
export function WorkspaceProvider({
  org,
  workspaceSlug,
  workspace,
  workspaces,
  orgLayer = false,
  nodes: serverNodes,
  currentUser,
  children,
}: {
  org: string;
  workspaceSlug: string;
  workspace: WorkspaceCard | null;
  workspaces: WorkspaceCard[];
  orgLayer?: boolean;
  nodes: KnowledgeNode[];
  currentUser: CurrentUser;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const address = useMemo<WorkspaceAddress>(
    () => ({ org, slug: workspaceSlug }),
    [org, workspaceSlug],
  );
  const apiRef = workspaceApiRef(address);
  const activeNodeId = useMemo(() => {
    const m = pathname.match(/\/w\/[^/]+\/[^/]+\/n\/([^/?#]+)/);
    return m ? (m[1] ?? null) : null;
  }, [pathname]);

  const [navigation, setNavigation] = useState<WorkspaceNavigationPreference>(
    DEFAULT_WORKSPACE_NAVIGATION,
  );
  const [navigationHydrated, setNavigationHydrated] = useState(false);
  const navigationWorkspaceRef = useRef<string | null>(null);
  const routeViewSlug = useMemo(
    () => viewSlugFromPathname(pathname, address),
    [pathname, address],
  );
  const activeViewSlug = routeViewSlug ?? navigation.last_view_slug;

  // Read the navigation preference for this workspace, then (a microtask
  // later, once React has applied it) allow the persist effect below to
  // write — otherwise switching workspaces would save A's preference under B.
  useEffect(() => {
    setNavigationHydrated(false);
    setNavigation(workspaceNavigation.get(apiRef));
    queueMicrotask(() => {
      navigationWorkspaceRef.current = apiRef;
      setNavigationHydrated(true);
    });
  }, [apiRef]);

  useEffect(() => {
    if (!navigationHydrated || navigationWorkspaceRef.current !== apiRef) return;
    workspaceNavigation.set(apiRef, navigation);
  }, [navigation, navigationHydrated, apiRef]);

  useEffect(() => {
    if (!routeViewSlug) return;
    setNavigation((current) =>
      current.last_view_slug === routeViewSlug
        ? current
        : { ...current, last_view_slug: routeViewSlug },
    );
  }, [routeViewSlug]);

  const [views, setViews] = useState<SavedView[]>([]);
  const [viewsLoading, setViewsLoading] = useState(true);
  const [viewsError, setViewsError] = useState<string | null>(null);
  const [activeViewResult, setActiveViewResult] =
    useState<ResolvedViewQuery | null>(null);
  const [activeViewGraph, setActiveViewGraph] = useState<GraphSnapshot | null>(null);
  const [graphRefreshTick, setGraphRefreshTick] = useState(0);
  const graphRefreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolvedViewIdRef = useRef<string | null>(null);

  const refreshViews = useCallback(async () => {
    setViewsLoading(true);
    try {
      const response = await fetch(
        `/api/views?workspace=${encodeURIComponent(apiRef)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("Couldn’t load workspace views");
      const body = (await response.json()) as { views?: SavedView[] };
      setViews(Array.isArray(body.views) ? body.views : []);
      setViewsError(null);
    } catch (error) {
      setViewsError(error instanceof Error ? error.message : "Couldn’t load workspace views");
    } finally {
      setViewsLoading(false);
    }
  }, [apiRef]);

  useEffect(() => {
    void refreshViews();
  }, [refreshViews]);

  const activeView = useMemo(
    () =>
      views.find(
        (view) => view.slug === activeViewSlug || view.system_key === activeViewSlug,
      ) ?? null,
    [activeViewSlug, views],
  );

  useEffect(() => {
    if (!activeView) {
      resolvedViewIdRef.current = null;
      setActiveViewResult(null);
      setActiveViewGraph(null);
      return;
    }
    const switchingView = resolvedViewIdRef.current !== activeView.id;
    // A route change must not show the previous view under a new title. A
    // realtime refresh of the same view keeps the current graph mounted so
    // Sigma can reconcile the next snapshot without a blank loading frame.
    if (switchingView) {
      setActiveViewResult(null);
      setActiveViewGraph(null);
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/views/${encodeURIComponent(activeView.id)}/resolve?workspace=${encodeURIComponent(apiRef)}`,
          { method: "POST", cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) throw new Error("Couldn’t resolve active view");
        const body = (await response.json()) as { result?: ResolvedViewQuery; graph?: GraphSnapshot };
        if (!controller.signal.aborted) {
          resolvedViewIdRef.current = activeView.id;
          setActiveViewResult(body.result ?? null);
          setActiveViewGraph(body.graph ?? null);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (switchingView) {
            setActiveViewResult(null);
            setActiveViewGraph(null);
          }
          setViewsError(error instanceof Error ? error.message : "Couldn’t resolve active view");
        }
      }
    })();
    return () => controller.abort();
  }, [activeView, apiRef, serverNodes, graphRefreshTick]);

  const invalidateActiveGraph = useCallback(() => {
    if (activeView?.presentation.renderer !== "graph" || graphRefreshDebounceRef.current) return;
    graphRefreshDebounceRef.current = setTimeout(() => {
      graphRefreshDebounceRef.current = null;
      setGraphRefreshTick((current) => current + 1);
    }, 200);
  }, [activeView]);
  useEffect(() => () => {
    if (graphRefreshDebounceRef.current) clearTimeout(graphRefreshDebounceRef.current);
  }, []);
  // Unrolled because hooks cannot run in a loop; the tuple is fixed-length.
  useWorkspaceBroadcast(GRAPH_REALTIME_EVENTS[0], invalidateActiveGraph);
  useWorkspaceBroadcast(GRAPH_REALTIME_EVENTS[1], invalidateActiveGraph);
  useWorkspaceBroadcast(GRAPH_REALTIME_EVENTS[2], invalidateActiveGraph);
  useWorkspaceBroadcast(GRAPH_REALTIME_EVENTS[3], invalidateActiveGraph);
  useWorkspaceBroadcast(GRAPH_REALTIME_EVENTS[4], invalidateActiveGraph);
  useWorkspaceBroadcast(GRAPH_REALTIME_EVENTS[5], invalidateActiveGraph);
  useWorkspaceBroadcast(GRAPH_REALTIME_EVENTS[6], invalidateActiveGraph);
  useWorkspaceBroadcast(GRAPH_REALTIME_EVENTS[7], invalidateActiveGraph);
  useWorkspaceBroadcast(GRAPH_REALTIME_EVENTS[8], invalidateActiveGraph);

  useWorkspaceBroadcast("view.changed", () => {
    void refreshViews();
  });

  // Optimistic overlay — temp nodes inserted by createNode before the server
  // round-trip completes. We track a `pending` map keyed by tempId; an entry
  // is removed once the server-confirmed node id is known OR a node with the
  // same parent+title arrives via `serverNodes` (covers the case where the
  // route returns before the Promise resolves and the layout re-renders).
  const [tempNodes, setTempNodes] = useState<KnowledgeNode[]>([]);
  const [summaryPatches, setSummaryPatches] = useState<
    Record<string, Partial<KnowledgeNode>>
  >({});
  const confirmedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (tempNodes.length === 0) return;
    const serverIds = new Set(serverNodes.map((n) => n.id));
    setTempNodes((current) =>
      current.filter((t) => {
        if (serverIds.has(t.id)) return false;
        if (confirmedIdsRef.current.has(t.id)) return false;
        // Match by parent + title against confirmed server nodes (a refresh
        // delivered the real node before our fetch promise resolved).
        const matched = serverNodes.find(
          (n) => n.parent_id === t.parent_id && n.title === t.title,
        );
        return !matched;
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverNodes]);

  // Safety net: no optimistic placeholder should survive past 5s. If one does,
  // it means the swap-in-place never happened (network failure path) — prune
  // it so the UI doesn't ship a permanently-fake row.
  useEffect(() => {
    const stale = tempNodes.filter(
      (t) => (t.data as { __optimistic?: boolean }).__optimistic === true,
    );
    if (stale.length === 0) return;
    const handle = setTimeout(() => {
      setTempNodes((current) =>
        current.filter(
          (t) =>
            !stale.some(
              (s) =>
                s.id === t.id &&
                (t.data as { __optimistic?: boolean }).__optimistic === true,
            ),
        ),
      );
    }, 5000);
    return () => clearTimeout(handle);
  }, [tempNodes]);

  const patchNodeSummary = useCallback(
    (nodeId: string, summary: Partial<KnowledgeNode>) => {
      setSummaryPatches((current) => ({
        ...current,
        [nodeId]: { ...(current[nodeId] ?? {}), ...summary },
      }));
    },
    [],
  );

  // Prune summary patches the moment the server catches up. Patches win over
  // `serverNodes` in the merge below, so a stale patch left behind would pin
  // old values forever (e.g. hide a later move made by another client). Any
  // patch that carries `updated_at` is dropped once the server row is at
  // least as fresh.
  useEffect(() => {
    setSummaryPatches((current) => {
      const ids = Object.keys(current);
      if (ids.length === 0) return current;
      let changed = false;
      const next = { ...current };
      for (const id of ids) {
        const patchedAt = next[id]?.updated_at;
        if (typeof patchedAt !== "string") continue;
        const server = serverNodes.find((node) => node.id === id);
        if (server && Date.parse(server.updated_at) >= Date.parse(patchedAt)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [serverNodes]);

  // Archived nodes are out of the way: `nodes` (what every renderer, tree
  // and picker reads) leaves them out, and `archivedNodes` is the shelf the
  // tasks board shows behind its Archive button. Archiving from the panel
  // patches the summary, so the node leaves the board in the same tick.
  const everyNode = useMemo(
    () => {
      const patched = serverNodes.map((node) => ({
        ...node,
        ...(summaryPatches[node.id] ?? {}),
      }));
      return tempNodes.length === 0 ? patched : [...patched, ...tempNodes];
    },
    [serverNodes, summaryPatches, tempNodes],
  );
  const nodes = useMemo(() => everyNode.filter((node) => node.status !== "archived"), [everyNode]);
  const archivedNodes = useMemo(() => everyNode.filter((node) => node.status === "archived"), [everyNode]);

  // --- Toasts ---------------------------------------------------------------
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);
  const pushToast = useCallback(
    (kind: ToastKind, message: string, opts?: ToastOptions) => {
      const { duration, action } = opts ?? {};
      const now = Date.now();
      let resultId = "";
      setToasts((current) => {
        // Collapse rapid-fire duplicates: same kind+message within 1.5s
        // bumps the existing entry's createdAt (resetting its timer) instead
        // of stacking a new one.
        const dupIdx = current.findIndex(
          (t) =>
            t.kind === kind &&
            t.message === message &&
            now - t.createdAt < 1500,
        );
        if (dupIdx !== -1) {
          const existing = current[dupIdx]!;
          resultId = existing.id;
          const next = current.slice();
          next[dupIdx] = { ...existing, createdAt: now, duration, action };
          return next;
        }
        const id = `t-${Math.random().toString(36).slice(2, 10)}`;
        resultId = id;
        return [...current, { id, kind, message, duration, action, createdAt: now }];
      });
      return resultId;
    },
    [],
  );
  const toastApi = useMemo<ToastApi>(
    () => ({
      info: (message, opts) => pushToast("info", message, opts),
      error: (message, opts) => pushToast("error", message, opts),
      dismiss: dismissToast,
    }),
    [pushToast, dismissToast],
  );

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const scrollOffsets = useRef<Map<string, number>>(new Map());

  const getNodeScroll = useCallback((nodeId: string) => {
    return scrollOffsets.current.get(nodeId) ?? 0;
  }, []);
  const setNodeScroll = useCallback((nodeId: string, offset: number) => {
    scrollOffsets.current.set(nodeId, offset);
  }, []);

  const nodeById = useMemo(() => {
    const m = new Map<string, KnowledgeNode>();
    nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [nodes]);

  // Canonical selection shared by every renderer: ONE floating panel over
  // the active surface with its own back/forward trail. The open node is
  // mirrored into the URL (`?inspect=<id>[&block=<id>]`, replaceState) so it
  // can be deep-linked, while the browser's history stays the page's own —
  // walking between nodes is the panel's Back/Forward, not the browser's.
  const [nodeHistory, setNodeHistory] = useState<NodeHistory>(EMPTY_NODE_HISTORY);
  const [nodePanelSize, setNodePanelSizeState] = useState<NodePanelSize>("half");
  const selectionFocusRef = useRef<HTMLElement | null>(null);
  const currentSelection = currentNodeSelection(nodeHistory);
  const inspectedNodeId = currentSelection?.id ?? null;
  const inspectedBlockId = currentSelection?.blockId ?? null;

  useEffect(() => {
    setNodePanelSizeState(nodePanelSizePreference.get(currentUser.id));
    if (!supabaseAuthConfigured()) return;
    let cancelled = false;
    void getSupabaseBrowserLazy().then((supabase) => supabase.auth.getUser()).then(({ data }) => {
      // Only an explicit panel size counts: the retired open-mode preference
      // must not drag anyone into a full-size panel by default.
      const remote = panelSizeFromLegacy(data.user?.user_metadata?.node_panel_size);
      if (!cancelled && remote) {
        setNodePanelSizeState(remote);
        nodePanelSizePreference.set(currentUser.id, remote);
      }
    });
    return () => { cancelled = true; };
  }, [currentUser.id]);
  const setNodePanelSize = useCallback((size: NodePanelSize) => {
    setNodePanelSizeState(size);
    nodePanelSizePreference.set(currentUser.id, size);
    if (supabaseAuthConfigured()) {
      void getSupabaseBrowserLazy().then((supabase) => supabase.auth.updateUser({ data: { node_panel_size: size } }));
    }
  }, [currentUser.id]);

  const syncSelectionUrl = useCallback((selection: NodeSelection | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (selection) {
      url.searchParams.set("inspect", selection.id);
      if (selection.blockId) url.searchParams.set("block", selection.blockId);
      else url.searchParams.delete("block");
    } else {
      url.searchParams.delete("inspect");
      url.searchParams.delete("block");
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  // A route change resets the trail; `?inspect=` on arrival seeds it (deep
  // links, the back button returning to a view that had a node open).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeNodeId) {
      setNodeHistory(EMPTY_NODE_HISTORY);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const id = params.get("inspect")?.trim() || null;
    setNodeHistory((current) => {
      const open = currentNodeSelection(current);
      if (!id) return open ? EMPTY_NODE_HISTORY : current;
      return pushNodeHistory(current, { id, blockId: params.get("block")?.trim() || null });
    });
  }, [pathname, address, activeNodeId]);

  const selectNode = useCallback(
    (id: string, options?: { blockId?: string | null; replace?: boolean }) => {
      const blockId = options?.blockId?.trim() || null;
      if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
        selectionFocusRef.current = document.activeElement;
      }
      if (activeNodeId) {
        // On a node page, a node link is a page link.
        const returnTo = new URLSearchParams(window.location.search).get("return_to") ?? workspacePath(address);
        router.push(fullNodeUrl(address, { nodeId: id, blockId, returnTo }));
        return;
      }
      const selection = { id, blockId };
      setNodeHistory((current) => pushNodeHistory(current, selection));
      syncSelectionUrl(selection);
    },
    [activeNodeId, address, router, syncSelectionUrl],
  );

  const closeNode = useCallback(() => {
    if (activeNodeId) {
      const returnTo = new URLSearchParams(window.location.search).get("return_to");
      router.push((returnTo || workspacePath(address)) as Route);
      return;
    }
    setNodeHistory(EMPTY_NODE_HISTORY);
    syncSelectionUrl(null);
    queueMicrotask(() => selectionFocusRef.current?.focus());
  }, [activeNodeId, address, router, syncSelectionUrl]);

  const goBackNode = useCallback(() => {
    const next = stepNodeHistory(nodeHistory, -1);
    if (next === nodeHistory) return;
    setNodeHistory(next);
    syncSelectionUrl(currentNodeSelection(next));
  }, [nodeHistory, syncSelectionUrl]);

  const goForwardNode = useCallback(() => {
    const next = stepNodeHistory(nodeHistory, 1);
    if (next === nodeHistory) return;
    setNodeHistory(next);
    syncSelectionUrl(currentNodeSelection(next));
  }, [nodeHistory, syncSelectionUrl]);

  const openNodePage = useCallback((id?: string) => {
    const target = id ?? inspectedNodeId;
    if (!target || typeof window === "undefined") return;
    const here = new URL(window.location.href);
    here.searchParams.delete("inspect");
    here.searchParams.delete("block");
    const returnTo = `${here.pathname}${here.search}${here.hash}`;
    router.push(fullNodeUrl(address, { nodeId: target, blockId: id ? null : inspectedBlockId, returnTo }));
  }, [address, inspectedBlockId, inspectedNodeId, router]);

  // Hydrate the sidebar flag from localStorage once per workspace change.
  // `hydrated` gates the persist effect so the default never overwrites
  // what was stored before the read.
  useEffect(() => {
    try {
      const rawLayout = localStorage.getItem(layoutKey(apiRef));
      if (rawLayout) {
        const parsed = JSON.parse(rawLayout) as { sidebarOpen?: boolean };
        if (typeof parsed.sidebarOpen === "boolean")
          setSidebarOpen(parsed.sidebarOpen);
      }
    } catch {
      // ignore
    }
    setHydrated(true);
  }, [apiRef]);

  // Persist layout
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(layoutKey(apiRef), JSON.stringify({ sidebarOpen }));
  }, [sidebarOpen, apiRef, hydrated]);

  const toggleSidebar = useCallback(() => setSidebarOpen((s) => !s), []);

  // ── Realtime: propagate "what page am I on" to presence so peers can see
  // me on the tree, and react to tree-invalidation broadcasts so any client's
  // create/rename/delete instantly shows up here.
  const realtime = useWorkspaceRealtime();
  useEffect(() => {
    realtime.setPageId(activeNodeId);
  }, [realtime, activeNodeId]);

  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshDebounceRef.current) return;
    refreshDebounceRef.current = setTimeout(() => {
      refreshDebounceRef.current = null;
      router.refresh();
    }, 200);
  }, [router]);
  useEffect(() => {
    return () => {
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current);
        refreshDebounceRef.current = null;
      }
    };
  }, []);

  // Listen to any node-tree event and trigger a debounced RSC refresh. The
  // existing optimistic-overlay logic dedupes our own author echo via the
  // confirmedIds set, so we don't need a per-event suppression here.
  useWorkspaceBroadcast("node.created", scheduleRefresh);
  useWorkspaceBroadcast("node.renamed", scheduleRefresh);
  useWorkspaceBroadcast("node.deleted", scheduleRefresh);
  useWorkspaceBroadcast("node.moved", scheduleRefresh);
  useWorkspaceBroadcast("node.updated", (event) => {
    const payload = event.payload as {
      nodeId?: string;
      summary?: Partial<KnowledgeNode>;
    };
    if (!payload.nodeId || !payload.summary) return;
    setSummaryPatches((current) => ({
      ...current,
      [payload.nodeId!]: { ...(current[payload.nodeId!] ?? {}), ...payload.summary },
    }));
  });
  useWorkspaceBroadcast("tree.invalidated", scheduleRefresh);

  const createNode = useCallback(
    async (input: {
      title: string;
      kind: NodeKind;
      parent_id?: string | null;
      content_md?: string;
      status?: NodeStatus | null;
      priority?: Priority | null;
      data?: Record<string, unknown>;
      tag_ids?: string[];
      navigate?: boolean;
    }): Promise<KnowledgeNode | null> => {
      const parent_id: string | null = input.parent_id ?? null;

      // Optimistic temp node: shows in the sidebar and views instantly.
      const now = new Date().toISOString();
      const tempId = `temp-${Math.random().toString(36).slice(2, 10)}`;
      const assignedTags = input.tag_ids?.map((id) =>
        serverNodes.flatMap((node) => node.tags).find((tag) => tag.id === id),
      ).filter((tag): tag is WorkspaceTag => Boolean(tag)) ?? [];
      const tempNode: KnowledgeNode = {
        id: tempId,
        workspace_id: workspace?.id ?? "",
        parent_id,
        kind: input.kind,
        slug: tempId,
        title: input.title,
        content_md: input.content_md ?? "",
        data: { ...(input.data ?? {}), __optimistic: true },
        tags: assignedTags,
        status: input.status ?? null,
        priority: input.priority ?? null,
        assignee_id: null,
        due_date: null,
        position: Number.MAX_SAFE_INTEGER,
        created_by: null,
        created_at: now,
        updated_at: now,
      };
      setTempNodes((current) => [...current, tempNode]);

      try {
        const res = await fetch("/api/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace: apiRef,
            title: input.title,
            kind: input.kind,
            parent_id,
            content_md: input.content_md,
            status: input.status,
            priority: input.priority,
            data: input.data,
            tag_ids: input.tag_ids,
          }),
        });
        if (!res.ok) {
          setTempNodes((current) => current.filter((t) => t.id !== tempId));
          pushToast("error", `Couldn't create "${input.title}"`);
          return null;
        }
        const json = (await res.json()) as { node?: KnowledgeNode };
        if (!json.node) {
          setTempNodes((current) => current.filter((t) => t.id !== tempId));
          pushToast("error", `Couldn't create "${input.title}"`);
          return null;
        }
        const node = json.node;
        confirmedIdsRef.current.add(tempId);
        // Swap the temp entry's identity in-place to the real server node.
        // It stays in our local overlay until serverNodes catches up on the
        // next layout render — at which point the prune effect drops it.
        // This avoids an unconditional router.refresh() round-trip.
        // The server response already lacks `__optimistic`; we drop any stale
        // copy of that flag defensively.
        setTempNodes((current) =>
          current.map((t) => {
            if (t.id !== tempId) return t;
            const serverData = { ...(node.data ?? {}) } as Record<
              string,
              unknown
            >;
            delete serverData.__optimistic;
            return { ...node, data: serverData };
          }),
        );
        // Refresh BEFORE navigating so the layout data is fresh by the
        // time the new page renders. router.refresh() acts on the current
        // route; doing it after a router.push could refresh a route the
        // user already left. The optimistic overlay covers the visible
        // gap until serverNodes catches up.
        router.refresh();
        if (input.navigate !== false) router.push(workspacePath(address, `n/${node.id}`) as Route);
        // Tell every other connected tab in the workspace that the tree
        // changed. Triggers their own debounced router.refresh() so the new
        // node shows up in the sidebar without manual reload.
        realtime.broadcast("node.created", { nodeId: node.id });
        return node;
      } catch {
        setTempNodes((current) => current.filter((t) => t.id !== tempId));
        pushToast("error", `Couldn't create "${input.title}"`);
        return null;
      }
    },
    [serverNodes, router, address, apiRef, workspace?.id, pushToast, realtime],
  );

  const renameNode = useCallback(
    async (id: string, title: string): Promise<boolean> => {
      const trimmed = title.trim();
      if (!trimmed) return false;
      try {
        const res = await fetch(`/api/nodes/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace: apiRef, title: trimmed }),
        });
        if (!res.ok) {
          pushToast("error", `Couldn't rename`);
          return false;
        }
        router.refresh();
        realtime.broadcast("node.renamed", { nodeId: id, title: trimmed });
        return true;
      } catch {
        pushToast("error", `Couldn't rename`);
        return false;
      }
    },
    [apiRef, router, pushToast, realtime],
  );

  const deleteNode = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await fetch(
          `/api/nodes/${encodeURIComponent(id)}?workspace=${encodeURIComponent(apiRef)}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          pushToast("error", `Couldn't delete`);
          return false;
        }
        // Leave the page of a node that no longer exists.
        if (activeNodeId === id) {
          router.push(workspacePath(address) as Route);
        }
        router.refresh();
        realtime.broadcast("node.deleted", { nodeId: id });
        return true;
      } catch {
        pushToast("error", `Couldn't delete`);
        return false;
      }
    },
    [apiRef, address, activeNodeId, router, pushToast, realtime],
  );

  const duplicateNode = useCallback(
    async (id: string): Promise<KnowledgeNode | null> => {
      const original = nodeById.get(id);
      if (!original) {
        pushToast("error", `Couldn't duplicate`);
        return null;
      }
      const semanticParent = original.parent_id && nodeById.has(original.parent_id)
        ? original.parent_id
        : null;
      try {
        const res = await fetch("/api/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace: apiRef,
            title: `${original.title} (copy)`,
            kind: original.kind,
            parent_id: semanticParent,
            content_md: original.content_md,
            tag_ids: original.tags.map((tag) => tag.id),
          }),
        });
        if (!res.ok) {
          pushToast("error", `Couldn't duplicate`);
          return null;
        }
        const json = (await res.json()) as { node?: KnowledgeNode };
        router.refresh();
        if (json.node) {
          realtime.broadcast("node.created", { nodeId: json.node.id });
        }
        return json.node ?? null;
      } catch {
        pushToast("error", `Couldn't duplicate`);
        return null;
      }
    },
    [nodeById, apiRef, router, pushToast, realtime],
  );

  // Settings dialog state + density bootstrap
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  useEffect(() => {
    // Fallback only — `theme-script.tsx` sets `data-density` + `data-text-scale`
    // before paint to avoid FOUC. This effect reconciles when the pre-paint
    // script failed (e.g. localStorage disabled) so CSS vars still apply.
    const d = densityStore.get();
    if (document.documentElement.dataset.density !== d) {
      document.documentElement.dataset.density = d;
    }
    const t = textScaleStore.get();
    if (document.documentElement.dataset.textScale !== t) {
      document.documentElement.dataset.textScale = t;
    }
  }, []);

  // Keyboard shortcuts: ⌘B sidebar, ⌘W close the open node page (back to
  // where it was opened from), ⌘, settings. ⌘K (palette) is handled by the
  // palette itself.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === ",") {
        e.preventDefault();
        openSettings();
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (k === "w" && activeNodeId) {
        e.preventDefault();
        closeNode();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar, closeNode, activeNodeId, openSettings]);

  const value: WorkspaceCtx = {
    address,
    workspaceSlug,
    workspace,
    workspaces,
    orgLayer,
    nodes,
    archivedNodes,
    currentUser,
    views,
    viewsLoading,
    viewsError,
    activeView,
    activeViewSlug,
    activeViewResult,
    activeViewGraph,
    refreshViews,
    inspectedNodeId,
    inspectedBlockId,
    nodePanelSize,
    setNodePanelSize,
    selectNode,
    closeNode,
    goBackNode,
    goForwardNode,
    canGoBackNode: canGoBack(nodeHistory),
    canGoForwardNode: canGoForward(nodeHistory),
    openNodePage,
    sidebarOpen,
    toggleSidebar,
    activeNodeId,
    getNodeScroll,
    setNodeScroll,
    createNode,
    renameNode,
    deleteNode,
    duplicateNode,
    patchNodeSummary,
    settingsOpen,
    openSettings,
    closeSettings,
    toasts,
    toast: toastApi,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
