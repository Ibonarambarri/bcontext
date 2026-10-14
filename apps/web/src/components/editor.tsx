"use client";

/**
 * The node body editor: TipTap over ProseMirror, with Yjs collaboration,
 * markdown as the canonical format and a handful of Bcontext-specific
 * behaviours layered on. Loaded only through `lazy-node-body.tsx`
 * (`LazyEditor`) so its chunk stays out of the route's first load; mounted
 * by the node page and by `agents/meeting-node-view.tsx` for meetings.
 *
 * Structure of `Editor`, top to bottom:
 *   · identity — `useStableCollabUser` gives anonymous viewers a per-browser
 *     id; `useCollabSession` opens one Y.Doc + Awareness + `CollabProvider`
 *     per node id and tears it down on navigation (a stale room echoing into
 *     a new node is the bug that rule prevents);
 *   · `useEditor` — StarterKit (undo/redo OFF when collab is on: Yjs has its
 *     own), lowlight code blocks (`editor-code-block.tsx`), tables, callout,
 *     the local `ImageNode`, slash and mention menus, and the `Collab`
 *     extension binding the Y.Doc's `prosemirror` fragment. With collab the
 *     editor starts EMPTY and ySyncPlugin owns the content; without it the
 *     initial markdown is set directly;
 *   · saving — `onUpdate` ignores transactions tagged `y-sync$` (remote
 *     edits must not echo-PATCH), debounces (700 ms alone, 1500 ms in a
 *     room) and `PATCH /api/nodes/:id` with `content_md` from
 *     `htmlToMarkdown`. Markdown is the source of truth; HTML never leaves
 *     the browser;
 *   · seeding a fresh room — after a grace window, if the shared fragment is
 *     still empty, the first client pushes the server markdown in; the wait
 *     is what stops two simultaneous joiners from seeding twice;
 *   · window events — `bcontext:slash-image` (file picker),
 *     `bcontext:autofix` (rewrite → `AutofixReview`, applied through the
 *     normal save path with a `change_context`),
 *     `bcontext:active-node-may-be-edited` (Nexo wrote to this node: refetch
 *     unless there are unsaved local edits — local always wins);
 *   · deep links — `highlightChunk` (RAG citation index, resolved by
 *     re-running the same chunker) and the `#block` hash (durable H2 block
 *     id) scroll to and flash the matching block.
 *
 * `SelectionAsk` ("Ask Nexo" over a text selection), the presence chips
 * and `SaveBadge` are the small UI pieces at the bottom of the file.
 */
import { useEditor, EditorContent } from "@tiptap/react";
import { Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { createLowlight } from "lowlight";
import js from "highlight.js/lib/languages/javascript";
import ts from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import python from "highlight.js/lib/languages/python";
import markdown from "highlight.js/lib/languages/markdown";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Sparkles, Users } from "lucide-react";
import { Avatar, Button, Chip, Kbd, Spinner, Tooltip } from "@heroui/react";
import { htmlToMarkdown, markdownToHtml } from "@/lib/markdown";
import { buildMentionCandidates } from "@bcontext-dev/contract/mention-search";
import { chunkMarkdown, extractBlocks } from "@bcontext-dev/contract/rag/chunk";
import {
  ImageUploadError,
  extractImageFiles,
  uploadImage,
} from "@bcontext-dev/contract/upload-image";
import { useToast, useWorkspace, type CurrentUser } from "./workspace-context";
import { PersonAvatar } from "./person-avatar";
import { SlashMenu } from "./slash-menu";
import { AutofixReview } from "./autofix-review";
import { Callout } from "./editor-callout";
import { EditorFooter, EditorToolbar } from "./editor-toolbar";
import { pasteTextToPipeTable } from "@/lib/csv-table";
import { withCodeBlockView } from "./editor-code-block";
import { MentionMenu } from "./mention-menu";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { CollabProvider } from "@/lib/collab/collab-provider";
import { Collab } from "@/lib/collab/tiptap-collab";
import { userColor } from "@/lib/collab/user-color";
import { blockIdFromHash } from "@bcontext-dev/contract/node-inspector";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { cn } from "@bcontext-dev/contract/utils";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";
import { supabaseAuthConfigured } from "@/lib/public-env";

/**
 * Minimal inline image node. We define this locally to avoid pulling in
 * `@tiptap/extension-image`. ProseMirror needs a node definition with an
 * `<img>` parseDOM rule so paste/insertContent round-trip cleanly; the
 * markdown serializer (turndown) then handles `<img>` → `![](url)`.
 */
const ImageNode = Node.create({
  name: "image",
  inline: true,
  group: "inline",
  draggable: true,
  selectable: true,
  atom: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "img[src]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", HTMLAttributes];
  },
});

/** `dirty` = edited and not yet sent; `saved` shows for a beat, then returns to `idle`. */
type SaveState = "idle" | "dirty" | "saving" | "saved";

export interface EditorProps {
  workspace: WorkspaceAddress;
  nodeId: string;
  nodeTitle?: string;
  initialMarkdown: string;
  /**
   * Optional 0-based chunk index to scroll to and briefly highlight after
   * mount, from the citation deep-link (`?highlight=`). Resolved by
   * re-running `chunkMarkdown` on the same content and locating the matching
   * text in the rendered DOM.
   */
  highlightChunk?: number | null;
  /** Durable H2 block id to scroll to; the URL hash wins when present. */
  initialBlockId?: string | null;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * `page` (default) owns its scroll pane and the reading-column layout of
   * `/n/<id>`. `panel` is the same editor inside the floating node panel:
   * no scroll pane of its own (the panel scrolls), no column padding, a
   * shorter minimum height and no per-node scroll memory (that belongs to
   * the page). The save path and collab wiring are identical.
   */
  variant?: "page" | "panel";
  /**
   * The server's node after each successful body save. The floating panel
   * uses it to keep its `updated_at` current, so a status change made right
   * after typing is not refused as a conflict with the person's own edit.
   */
  onSaved?: (node: KnowledgeNode) => void;
}

export function Editor({
  workspace,
  nodeId,
  nodeTitle,
  initialMarkdown,
  highlightChunk,
  initialBlockId,
  header,
  footer,
  variant = "page",
  onSaved,
}: EditorProps) {
  const { getNodeScroll, setNodeScroll, nodes, currentUser } = useWorkspace();
  const inPanel = variant === "panel";
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const toast = useToast();
  const router = useRouter();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [resolvedBlockId, setResolvedBlockId] = useState<string | null>(
    initialBlockId ?? null,
  );
  const saveStateRef = useRef<SaveState>("idle");
  saveStateRef.current = saveState;

  useEffect(() => {
    const sync = () => {
      setResolvedBlockId(initialBlockId ?? blockIdFromHash(window.location.hash));
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [initialBlockId, nodeId]);

  // Live-collab session — one Y.Doc + Awareness + provider per open node.
  // Resolved once the user identity is upgraded (anon → stable per-browser).
  const stableUser = useStableCollabUser(currentUser);
  const collab = useCollabSession(nodeId, stableUser);
  const [autofix, setAutofix] = useState<
    | null
    | { phase: "loading" }
    | {
        phase: "review";
        before: string;
        after: string;
        model: string;
        segments?: { total: number; edited: number };
      }
  >(null);
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChangeContextRef = useRef<{
    source: string;
    review: { status: "accepted"; label: string; review_url: string | null };
  } | null>(null);
  const initialHtml = useRef(markdownToHtml(initialMarkdown));
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const mentionCandidatesRef = useRef(buildMentionCandidates(nodes, nodeId));
  useEffect(() => {
    mentionCandidatesRef.current = buildMentionCandidates(nodes, nodeId);
  }, [nodes, nodeId]);

  // Whether the client believes Supabase Storage is available. The
  // server-side check still gates the actual write — this just decides
  // between the API hop and the data-URL fallback.
  const supabaseEnabled = useMemo(
    () => supabaseAuthConfigured(),
    [],
  );
  // One toast per session reminding demo-mode users that images embedded
  // as data URLs won't persist after a reload (the markdown body keeps
  // them but reloading clobbers `initialMarkdown` from the server snapshot
  // when nothing was persisted yet).
  const demoWarnedRef = useRef(false);

  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const handleImageFiles = useCallback(
    async (files: File[], at?: { from: number; to: number }) => {
      const editor = editorRef.current;
      if (!editor || files.length === 0) return;
      for (const file of files) {
        try {
          const result = await uploadImage(file, {
            supabaseEnabled,
            workspace: workspaceApiRef(workspace),
            nodeId,
          });
          if (result.mode === "demo" && !demoWarnedRef.current) {
            demoWarnedRef.current = true;
            toast.info(
              "Image embedded inline — won't persist across reloads (demo mode).",
            );
          }
          const chain = editor.chain().focus();
          if (at) chain.setTextSelection(at);
          chain
            .insertContent({
              type: "image",
              attrs: { src: result.url, alt: file.name ?? "" },
            })
            .run();
        } catch (err) {
          const msg =
            err instanceof ImageUploadError
              ? err.message
              : "Could not upload image";
          toast.error(msg);
        }
      }
    },
    [nodeId, supabaseEnabled, toast, workspace],
  );

  const lowlight = useMemo(() => {
    const ll = createLowlight();
    ll.register("js", js);
    ll.register("javascript", js);
    ll.register("ts", ts);
    ll.register("typescript", ts);
    // TSX/JSX share the typescript/javascript grammars in highlight.js.
    ll.register("tsx", ts);
    ll.register("jsx", js);
    ll.register("json", json);
    ll.register("bash", bash);
    ll.register("sh", bash);
    ll.register("shell", bash);
    ll.register("sql", sql);
    ll.register("py", python);
    ll.register("python", python);
    ll.register("md", markdown);
    ll.register("markdown", markdown);
    ll.register("css", css);
    ll.register("html", xml);
    ll.register("xml", xml);
    return ll;
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        link: { openOnClick: false },
        // Yjs ships its own per-client undo manager via `yUndoPlugin`. Two
        // undo stacks compete and produce confusing behaviour, so disable
        // StarterKit's undo/redo when a collab session is active.
        undoRedo: collab ? false : undefined,
      }),
      withCodeBlockView(CodeBlockLowlight).configure({
        lowlight,
        HTMLAttributes: { class: "hljs" },
      }),
      Placeholder.configure({
        placeholder: "Write, press '/' for commands…",
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      // Markdown is the source of truth: pipe tables can't carry column
      // widths, so resizing stays off and the schema stays round-trippable.
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Callout,
      ImageNode,
      SlashMenu,
      MentionMenu.configure({
        workspace,
        getCandidates: () => mentionCandidatesRef.current,
      }),
      ...(collab
        ? [
            Collab.configure({
              doc: collab.doc,
              awareness: collab.awareness,
              field: "prosemirror",
            }),
          ]
        : []),
    ],
    // When collab is on, ySyncPlugin owns the document state. Starting with
    // `content` would race the binding and yield an empty editor on join.
    content: collab ? "" : initialHtml.current,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: cn(
          "ProseMirror prose-base max-w-none focus:outline-none",
          inPanel ? "min-h-[240px]" : "min-h-[60vh]",
        ),
      },
      handlePaste(_view, event) {
        const files = extractImageFiles(event.clipboardData);
        if (files.length > 0) {
          event.preventDefault();
          void handleImageFiles(files);
          return true;
        }
        // Spreadsheet cells arrive as TSV text (no text/html table needed) —
        // turn a consistent grid into a real table instead of pasting a blob.
        const clip = event.clipboardData;
        if (clip && !clip.getData("text/html")) {
          const tableMd = pasteTextToPipeTable(clip.getData("text/plain"));
          if (tableMd) {
            event.preventDefault();
            editorRef.current
              ?.chain()
              .focus()
              .insertContent(markdownToHtml(tableMd))
              .run();
            return true;
          }
        }
        return false;
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const dt = (event as DragEvent).dataTransfer;
        const files = extractImageFiles(dt);
        if (files.length === 0) return false;
        event.preventDefault();
        const coords = view.posAtCoords({
          left: (event as DragEvent).clientX,
          top: (event as DragEvent).clientY,
        });
        const at = coords ? { from: coords.pos, to: coords.pos } : undefined;
        void handleImageFiles(files, at);
        return true;
      },
    },
    onUpdate({ editor, transaction }) {
      // ySyncPlugin replays remote updates as ProseMirror transactions; the
      // `y-sync$` meta is the canonical "this edit came from the wire" tag
      // exposed by y-prosemirror. Ignore those so peers don't echo-PATCH and
      // hammer the server with redundant writes for the same canonical state.
      if (collab && (transaction.getMeta("y-sync$") || transaction.getMeta("yjs$"))) {
        return;
      }
      setSaveState("dirty");
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const html = editor.getHTML();
      // Collab clients converge to identical Y.Doc state, but markdown
      // PATCHes still race. A longer debounce keeps the canonical store
      // eventually-consistent without write storms during heavy co-editing.
      const wait = collab ? 1500 : 700;
      debounceRef.current = setTimeout(async () => {
        setSaveState("saving");
        try {
          const md = htmlToMarkdown(html);
          const changeContext = pendingChangeContextRef.current;
          const res = await fetch(`/api/nodes/${nodeId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspace: workspaceApiRef(workspace),
              content_md: md,
              ...(changeContext ? { change_context: changeContext } : {}),
            }),
          });
          if (!res.ok) {
            setSaveState("dirty");
            toast.error("Couldn't save changes");
            return;
          }
          if (pendingChangeContextRef.current === changeContext) {
            pendingChangeContextRef.current = null;
          }
          const saved = (await res.json().catch(() => null)) as { node?: KnowledgeNode } | null;
          if (saved?.node) onSavedRef.current?.(saved.node);
          setSaveState("saved");
          setTimeout(
            () => setSaveState((s) => (s === "saved" ? "idle" : s)),
            1200,
          );
        } catch {
          setSaveState("dirty");
          toast.error("Couldn't save changes");
        }
      }, wait);
    },
  }, [collab?.doc, nodeId]);

  // Keep the upload handler's editor reference in sync.
  editorRef.current = editor;

  // Slash menu's "Image" item fires a window event so the editor can open
  // a file picker without the menu needing access to the editor instance.
  useEffect(() => {
    function onSlashImage() {
      if (typeof document === "undefined") return;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/webp,image/gif";
      input.multiple = true;
      input.style.display = "none";
      input.addEventListener("change", () => {
        const files = input.files ? Array.from(input.files) : [];
        document.body.removeChild(input);
        if (files.length > 0) void handleImageFiles(files);
      });
      document.body.appendChild(input);
      input.click();
    }
    window.addEventListener("bcontext:slash-image", onSlashImage);
    return () => window.removeEventListener("bcontext:slash-image", onSlashImage);
  }, [handleImageFiles]);

  // Autofix: send the CURRENT body (including unsaved edits) to the rewrite
  // endpoint and open the review diff. Applying goes through setContent with
  // emit, so the normal debounced save path persists it.
  useEffect(() => {
    function onAutofix() {
      const ed = editorRef.current;
      if (!ed) return;
      const before = htmlToMarkdown(ed.getHTML());
      setAutofix({ phase: "loading" });
      void (async () => {
        try {
          const res = await fetch(`/api/nodes/${nodeId}/autofix`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspace: workspaceApiRef(workspace) }),
          });
          if (!res.ok) {
            const data = (await res.json().catch(() => null)) as
              | { error?: unknown; message?: string }
              | null;
            const code = typeof data?.error === "string" ? data.error : null;
            toast.error(
              res.status === 402
                ? // A monthly AI limit refused the call; who set it is not
                  // something the writer can change from here.
                  "The AI query limit for this month is reached."
                : code === "input_too_short"
                  ? "This note is too short to autofix."
                  : code === "no_gateway_key"
                    ? "Autofix needs an AI Gateway key configured."
                    : "Autofix failed. Try again in a minute.",
            );
            setAutofix(null);
            return;
          }
          const data = (await res.json()) as {
            rewritten_md: string;
            model: string;
            segments?: { total: number; edited: number };
          };
          setAutofix({
            phase: "review",
            before,
            after: data.rewritten_md,
            model: data.model,
            segments: data.segments,
          });
        } catch {
          toast.error("Autofix failed. Try again in a minute.");
          setAutofix(null);
        }
      })();
    }
    window.addEventListener("bcontext:autofix", onAutofix);
    return () => window.removeEventListener("bcontext:autofix", onAutofix);
  }, [nodeId, workspace, toast]);

  // Only refresh content when the node itself changes (navigation). A server
  // re-render that delivers a new `initialMarkdown` for the same node must not
  // clobber unsaved local edits.
  //
  // When collab is active ySyncPlugin owns the content — re-running setContent
  // would push a duplicate copy of the body into the shared doc, so the
  // collab seed path (below) handles initial content instead.
  useEffect(() => {
    if (!editor) return;
    if (collab) return;
    if (saveStateRef.current === "dirty" || saveStateRef.current === "saving") {
      return;
    }
    editor.commands.setContent(markdownToHtml(initialMarkdown), {
      emitUpdate: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, editor, collab]);

  // Publish local user identity into awareness so peers paint our caret
  // with the right colour + name. The y-prosemirror cursor plugin reads
  // `awareness.getStates().get(clientId).user`.
  useEffect(() => {
    if (!collab) return;
    collab.awareness.setLocalStateField("user", {
      name: stableUser.name,
      color: stableUser.color,
      id: stableUser.id,
    });
  }, [collab, stableUser.id, stableUser.name, stableUser.color]);

  // Track connected peers (everyone except us) so we can render the live
  // presence chip strip in the header.
  useEffect(() => {
    if (!collab) {
      setPeers([]);
      return;
    }
    const a = collab.awareness;
    function refresh() {
      const list: CollabPeer[] = [];
      a.getStates().forEach((state, clientId) => {
        if (clientId === a.clientID) return;
        const user = (state as { user?: { name?: string; id?: string } }).user;
        if (!user || !user.name) return;
        list.push({ clientId, name: user.name, id: user.id ?? String(clientId) });
      });
      // Stable order by clientId so chips don't shuffle on every keystroke.
      list.sort((x, y) => x.clientId - y.clientId);
      setPeers(list);
    }
    refresh();
    a.on("change", refresh);
    return () => a.off("change", refresh);
  }, [collab]);

  // Seed the Y.Doc from the server-canonical markdown the first time anyone
  // opens this node in a fresh room. We wait a short grace window for any
  // existing peer to send their sync-2 reply — only if the doc is still
  // empty after that do we populate it. Without this two clients joining
  // simultaneously would both seed and end up with a duplicated body.
  useEffect(() => {
    if (!editor || !collab) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      const frag = collab.doc.getXmlFragment("prosemirror");
      if (frag.length === 0 && initialMarkdown.trim().length > 0) {
        editor.commands.setContent(markdownToHtml(initialMarkdown), {
          emitUpdate: false,
        });
      }
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, collab, nodeId]);

  // Listen for Nexo-triggered edits to the active node. `nexo-provider.tsx`
  // dispatches this after a turn that wrote to a node. We refetch the latest
  // body and apply it only when the editor isn't dirty — local edits always
  // win to avoid clobbering unsaved work. A router.refresh() keeps the side
  // panels (backlinks/context) in sync.
  useEffect(() => {
    if (!editor) return;
    const isDirty = () => {
      const s = saveStateRef.current as SaveState;
      return s === "dirty" || s === "saving";
    };
    async function onMayBeEdited(e: Event) {
      const detail = (e as CustomEvent<{ nodeId?: string }>).detail;
      if (!detail || detail.nodeId !== nodeId) return;
      if (isDirty()) return;
      try {
        const res = await fetch(
          `/api/nodes/${encodeURIComponent(nodeId)}?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`,
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          node?: { content_md?: string };
        };
        const next = json.node?.content_md;
        if (typeof next !== "string") return;
        if (next === initialMarkdown) {
          router.refresh();
          return;
        }
        if (!editor || editor.isDestroyed) return;
        if (isDirty()) return;
        editor.commands.setContent(markdownToHtml(next), { emitUpdate: false });
        router.refresh();
      } catch {
        // best-effort
      }
    }
    window.addEventListener("bcontext:active-node-may-be-edited", onMayBeEdited);
    return () =>
      window.removeEventListener(
        "bcontext:active-node-may-be-edited",
        onMayBeEdited,
      );
  }, [editor, nodeId, workspace, initialMarkdown, router]);

  // Restore + persist the scroll offset per node. Page only: the panel's
  // pane belongs to the panel, and a zero written from here would wipe the
  // offset the page remembered for the same node.
  useEffect(() => {
    if (inPanel) return;
    const el = scrollRef.current;
    if (!el) return;
    const saved = getNodeScroll(nodeId);
    el.scrollTop = saved;
    function onScroll() {
      if (!el) return;
      setNodeScroll(nodeId, el.scrollTop);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (el) setNodeScroll(nodeId, el.scrollTop);
      el?.removeEventListener("scroll", onScroll);
    };
  }, [nodeId, getNodeScroll, setNodeScroll, inPanel]);

  // Citation deep-link: scroll the cited chunk into view and flash a
  // temporary highlight. Resolves the chunk text by re-running the same
  // chunker the embedding pipeline uses (`# title\n\n<content>`), then
  // finds the leading prose of that chunk in the rendered DOM.
  useEffect(() => {
    if (!editor) return;
    if (highlightChunk == null) return;
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const chunks = chunkMarkdown(
      nodeTitle ? `# ${nodeTitle}\n\n${initialMarkdown}` : initialMarkdown,
    );
    const chunk = chunks[highlightChunk];
    if (!chunk) return;

    const needle = pickHighlightNeedle(chunk.content);
    if (!needle) return;

    // Wait one frame so TipTap has actually committed nodes to the DOM.
    const handle = requestAnimationFrame(() => {
      const target = findBlockContaining(editor.view.dom, needle);
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("bcontext-chunk-highlight");
      const tid = setTimeout(() => {
        target.classList.remove("bcontext-chunk-highlight");
      }, 3000);
      cleanupRef.current = () => {
        clearTimeout(tid);
        target.classList.remove("bcontext-chunk-highlight");
      };
    });
    return () => {
      cancelAnimationFrame(handle);
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    // We intentionally only re-run when the editor binds or the target
    // changes; live-edits to initialMarkdown should not retrigger a flash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, highlightChunk, nodeId]);

  // Exact H2 deep-link. Unlike citation highlights (which address a chunk
  // index), inspector and graph references carry the durable block id.
  useEffect(() => {
    if (!editor || !resolvedBlockId) return;
    const block = extractBlocks(initialMarkdown).find(
      (candidate) => candidate.block_id === resolvedBlockId,
    );
    if (!block) return;
    const needle = pickHighlightNeedle(block.body_md);
    if (!needle) return;
    const handle = requestAnimationFrame(() => {
      const target = findBlockContaining(editor.view.dom, needle);
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("bcontext-chunk-highlight");
      const timeout = setTimeout(
        () => target.classList.remove("bcontext-chunk-highlight"),
        3000,
      );
      cleanupRef.current = () => {
        clearTimeout(timeout);
        target.classList.remove("bcontext-chunk-highlight");
      };
    });
    return () => cancelAnimationFrame(handle);
  }, [editor, resolvedBlockId, initialMarkdown]);

  const status = (
    <>
      {peers.length > 0 && <PresenceChips peers={peers} self={stableUser} />}
      <SaveBadge state={saveState} />
    </>
  );

  return (
    <div
      ref={scrollRef}
      className={inPanel ? "relative" : "scroll relative h-full overflow-y-auto bg-[var(--paper)]"}
    >
      <div
        className={inPanel ? undefined : "mx-auto"}
        style={inPanel ? undefined : {
          maxWidth: "var(--edit-max, 920px)",
          paddingInline: "var(--editor-px)",
          paddingBlock: "var(--editor-py)",
          paddingBottom: "120px",
        }}
      >
        {header}
        {/* In the panel the badge shares the toolbar row: there is no page
            corner for it to float in without covering the first line. The
            row is what sticks — the toolbar's own sticky would be boxed in
            by the flex cell. */}
        {inPanel ? (
          <div className="sticky top-0 z-10 flex items-start gap-2">
            <div className="min-w-0 flex-1"><EditorToolbar editor={editor} /></div>
            <div className="pointer-events-none flex h-8 shrink-0 items-center gap-2">{status}</div>
          </div>
        ) : (
          <EditorToolbar editor={editor} />
        )}
        <EditorContent editor={editor} />
        <EditorFooter editor={editor} />
        {footer}
      </div>
      <SelectionAsk scrollRef={scrollRef} nodeId={nodeId} />
      {inPanel ? null : (
        <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2">
          {status}
        </div>
      )}
      {autofix?.phase === "loading" && (
        <Chip
          size="sm"
          variant="soft"
          className="pointer-events-none absolute right-3 top-10 mono uppercase tracking-[0.08em]"
        >
          <Spinner size="sm" />
          <Chip.Label>autofixing</Chip.Label>
        </Chip>
      )}
      {autofix?.phase === "review" && (
        <AutofixReview
          before={autofix.before}
          after={autofix.after}
          model={autofix.model}
          segments={autofix.segments}
          onReject={() => setAutofix(null)}
          onAccept={() => {
            const ed = editorRef.current;
            if (ed) {
              pendingChangeContextRef.current = {
                source: "autofix",
                review: {
                  status: "accepted",
                  label: `Autofix rewrite · ${autofix.model}`,
                  review_url: null,
                },
              };
              ed.commands.setContent(markdownToHtml(autofix.after), {
                emitUpdate: true,
              });
            }
            setAutofix(null);
          }}
        />
      )}
    </div>
  );
}

interface CollabPeer {
  clientId: number;
  id: string;
  name: string;
}

function PresenceChips({
  peers,
  self,
}: {
  peers: CollabPeer[];
  self: CurrentUser;
}) {
  // Show the user + up to 3 peers as overlapping initials; the rest collapse
  // into a "+N" chip. Hover-title on each chip names the peer so the strip
  // works for both single-digit and crowded rooms without taking horizontal
  // space.
  const visible = peers.slice(0, 3);
  const overflow = peers.length - visible.length;
  return (
    <div className="pointer-events-auto flex items-center gap-0.5">
      <PresenceAvatar id={self.id} label={`${self.name} (you)`} />
      {visible.map((p) => (
        <PresenceAvatar key={p.clientId} id={p.id} label={p.name} />
      ))}
      {overflow > 0 && (
        <Avatar size="sm" className="size-5" title={`${overflow} more`}>
          <Avatar.Fallback className="text-[9px]">+{overflow}</Avatar.Fallback>
        </Avatar>
      )}
      <span className="mono ml-2 inline-flex items-center gap-1 text-[10.5px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
        <Users size={10} /> live
      </span>
    </div>
  );
}

/**
 * One face in the strip. The cursor colour stays on the caret and the name
 * tag inside the document; up here the person is their blobatar, the same
 * one the sidebar and the roster show, so a caret is matched to a face by
 * hovering the strip rather than by remembering a colour.
 */
function PresenceAvatar({ id, label }: { id: string; label: string }) {
  return (
    <Tooltip delay={150}>
      <Tooltip.Trigger aria-label={label}>
        <PersonAvatar user={{ id }} size={20} animate="hover" />
      </Tooltip.Trigger>
      <Tooltip.Content>
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  );
}

/**
 * "Ask Nexo" — anchored above the user's selection once ≥6 characters are
 * highlighted. Pressing it hands Nexo the exact text *and* the node it came
 * from, which is what lets "rewrite this" become a real edit rather than a
 * guess: the text goes straight into the `find` argument of a surgical
 * replace.
 */
function SelectionAsk({
  scrollRef,
  nodeId,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  nodeId: string;
}) {
  const [pos, setPos] = useState<{ x: number; y: number; text: string } | null>(
    null,
  );

  useEffect(() => {
    function recompute() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return setPos(null);
      const text = sel.toString().trim();
      if (text.length < 6) return setPos(null);
      const range = sel.getRangeAt(0);
      const container = scrollRef.current;
      if (!container) return setPos(null);
      // Confine to selections that originate inside the editor's scroll pane.
      const node =
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      if (!node || !container.contains(node)) return setPos(null);
      const rect = range.getBoundingClientRect();
      const parent = container.getBoundingClientRect();
      setPos({
        x: rect.left + rect.width / 2 - parent.left,
        y: rect.top - parent.top - 36 + container.scrollTop,
        text,
      });
    }

    document.addEventListener("selectionchange", recompute);
    const el = scrollRef.current;
    el?.addEventListener("scroll", () => setPos(null), { passive: true });
    return () => {
      document.removeEventListener("selectionchange", recompute);
    };
  }, [scrollRef]);

  if (!pos) return null;
  return (
    <Button
      size="sm"
      variant="primary"
      onMouseDown={(e) => {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("bcontext:nexo-selection", {
            detail: { text: pos.text, node_id: nodeId },
          }),
        );
        setPos(null);
        // Drop the selection so the floater goes away.
        window.getSelection()?.removeAllRanges();
      }}
      className="fade-in z-20 gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] shadow-lg"
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        transform: "translateX(-50%)",
      }}
    >
      <Sparkles size={12} /> Ask Nexo
      <Kbd className="border-white/25 bg-white/15 text-white/80">
        <Kbd.Content>↵</Kbd.Content>
      </Kbd>
    </Button>
  );
}

/**
 * Pick a short, distinctive substring from a chunk's content to use as the
 * search needle when locating the chunk in the rendered DOM. Skips heading
 * lines (the chunk usually starts with a heading we already render in the
 * page chrome) and falls back to the first non-empty line.
 */
function pickHighlightNeedle(content: string): string | null {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const body = lines.find((l) => !/^#{1,6}\s+/.test(l)) ?? lines[0];
  if (!body) return null;
  // Strip basic markdown markers so the needle matches the rendered text.
  const cleaned = body
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/[`*_~]/g, "")
    .trim();
  if (cleaned.length < 8) return cleaned || null;
  return cleaned.slice(0, 80);
}

/**
 * Find the closest block-level element under `root` whose text content
 * starts with (or contains) the needle. We bias toward block ancestors so
 * the resulting highlight covers a meaningful chunk of prose, not a stray
 * inline run.
 */
function findBlockContaining(
  root: HTMLElement,
  needle: string,
): HTMLElement | null {
  if (!needle) return null;
  const blocks = root.querySelectorAll<HTMLElement>(
    "p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, figure",
  );
  for (const el of Array.from(blocks)) {
    const text = (el.textContent ?? "").trim();
    if (text.includes(needle)) return el;
  }
  // Fallback: prefix match against a shorter needle handles small DOM
  // differences (e.g. rendered code-fences stripping whitespace).
  const short = needle.slice(0, Math.min(40, needle.length));
  for (const el of Array.from(blocks)) {
    const text = (el.textContent ?? "").trim();
    if (text.startsWith(short)) return el;
  }
  return null;
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state === "saving")
    return (
      <Chip size="sm" variant="soft" className="mono uppercase tracking-[0.08em]">
        <Loader2 size={10} className="animate-spin" />
        <Chip.Label>saving</Chip.Label>
      </Chip>
    );
  if (state === "saved")
    return (
      <Chip
        size="sm"
        variant="soft"
        color="success"
        className="mono uppercase tracking-[0.08em]"
      >
        <Check size={10} />
        <Chip.Label>saved</Chip.Label>
      </Chip>
    );
  if (state === "dirty")
    return (
      <Chip size="sm" variant="soft" className="mono uppercase tracking-[0.08em]">
        <Chip.Label>editing…</Chip.Label>
      </Chip>
    );
  return null;
}

interface CollabSession {
  doc: Y.Doc;
  awareness: Awareness;
  provider: CollabProvider;
}

/**
 * Maintain one Y.Doc + Awareness + CollabProvider per node id. Tearing
 * down on node change is critical: otherwise the old room keeps echoing
 * updates into the editor's now-detached state.
 */
function useCollabSession(
  nodeId: string,
  _user: CurrentUser,
): CollabSession | null {
  const [session, setSession] = useState<CollabSession | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const provider = new CollabProvider({ doc, awareness, nodeId });
    setSession({ doc, awareness, provider });
    return () => {
      provider.destroy();
      awareness.destroy();
      doc.destroy();
      setSession(null);
    };
  }, [nodeId]);

  return session;
}

const ANON_USER_KEY = "bcontext:collab:anon";

interface PersistedAnon {
  id: string;
  name: string;
}

/**
 * Anonymous identity needs to be (a) stable across reloads of the same
 * browser so peer colours don't shuffle, and (b) different from other tabs
 * of the same browser so two-tab collab demos work. We persist a fresh id
 * per `BroadcastChannel`-distinguishable origin in localStorage and derive
 * the colour from it deterministically.
 *
 * Signed-in users skip this entirely — their real user id is already stable
 * and unique across sessions.
 */
function useStableCollabUser(initial: CurrentUser): CurrentUser {
  const [user, setUser] = useState<CurrentUser>(initial);
  useEffect(() => {
    if (!initial.anonymous) {
      setUser(initial);
      return;
    }
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(ANON_USER_KEY);
      let persisted: PersistedAnon | null = null;
      if (raw) {
        try {
          persisted = JSON.parse(raw) as PersistedAnon;
        } catch {
          persisted = null;
        }
      }
      if (!persisted?.id) {
        persisted = {
          id: `anon-${Math.random().toString(36).slice(2, 10)}`,
          name: `Guest ${Math.floor(1000 + Math.random() * 9000)}`,
        };
        window.localStorage.setItem(ANON_USER_KEY, JSON.stringify(persisted));
      }
      setUser({
        id: persisted.id,
        email: null,
        name: persisted.name,
        color: userColor(persisted.id),
        anonymous: true,
      });
    } catch {
      // localStorage blocked — fall back to the server-rendered placeholder.
      setUser(initial);
    }
    // We deliberately key this only on the anon flag — once a real user is
    // signed in, we don't need to read localStorage again.
  }, [initial]);
  return user;
}
