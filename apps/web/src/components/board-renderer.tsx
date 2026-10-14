"use client";

/**
 * The kanban for `board`-renderer saved views, mounted by
 * `saved-board-view.tsx` with the nodes the view resolved to. Columns and
 * card membership come from the contract (`board/model`: `boardColumns`,
 * `groupBoardNodes`, `boardMovePatch`) so the same board can group by
 * status, priority or tag; this file owns only the `useKanban`
 * wiring, the optimistic drag-and-drop and the cards.
 *
 * The tricky part is who owns the truth. The `useKanban` list is the single
 * visual source while a move is in flight; the props (canonical, from the
 * server via the workspace context) re-seed it on every commit through
 * `reconcileBoardCard`, which keeps an optimistic column only while the
 * canonical one is provably stale. Drops are recorded in refs synchronously
 * inside `setColumn` — see the comment on `pendingDropsRef` for why state
 * would race. Moves persist through `persistBoardMove` (`PATCH /api/nodes`
 * with `if_updated_at`); success is silent, a 409 refetches.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bug,
  CalendarDays,
  CheckSquare,
  CircleDot,
  Hash,
  Plus,
  ListChecks,
} from "lucide-react";
import { Button, Chip } from "@heroui/react";
import {
  Kanban,
  useKanban,
  useKanbanCardPlaceholder,
  useKanbanColumn,
  type UseKanbanColumnOptions,
  type UseKanbanReturn,
} from "@/components/ui/kanban";
import { useToast, useWorkspace } from "@/components/workspace-context";
import { BoardTopScrollbar } from "@/components/board-top-scrollbar";
import {
  boardCardFields,
  boardColumns,
  boardGroupBy,
  boardMovePatch,
  boardValue,
  canMoveBoardCards,
  deriveBoardCreate,
  groupBoardNodes,
  type BoardBlockerState,
  type BoardColumn,
} from "@bcontext-dev/contract/board/model";
import { getNodeTags, type KnowledgeNode, type NodeSummary } from "@bcontext-dev/contract/types";
import { nodeSubtaskProgress } from "@bcontext-dev/contract/subtasks";
import { CardActionsMenu } from "@/components/card-actions-menu";
import { nodeActionsFor, useArchiveNode, useDeleteNode } from "@/components/node-actions";
import { NodeRevealRegion } from "@/components/node-reveal";
import { useHoverDwell } from "@/lib/use-hover-dwell";
import type { ViewPresentation, ViewQuery } from "@bcontext-dev/contract/views/schema";
import { persistBoardMove } from "@/lib/board/mutation";
import {
  boardMoveSummary,
  reconcileBoardCard,
  type PendingBoardMove,
} from "@/lib/board/optimistic";
import { cn, formatRelative } from "@bcontext-dev/contract/utils";
import { type WorkspaceAddress } from "@/web/workspace-url";

/** Column indicator per status value; other groupings fall back to the mute ink. */
const STATUS_DOT_COLOR: Record<string, string> = {
  todo: "oklch(70% 0.02 80)",
  in_progress: "var(--accent)",
  blocked: "var(--warn)",
  done: "oklch(70% 0 0)",
  review: "oklch(65% 0.08 250)",
  backlog: "var(--ink-mute)",
  archived: "var(--line-strong)",
};

// Card payload carried in the useKanban ListData. `column` is the board's
// current grouping value for this node (status/priority/tag/...), decoupled
// from the node's own fields so a single kanban instance can drive any
// groupBy without special-casing which node property represents "column".
interface CardItem {
  id: string;
  column: string;
  node: KnowledgeNode;
}

export function BoardRenderer({
  workspace,
  items,
  allNodes,
  query,
  presentation,
  blockers = {},
  emptyLabel = "No tasks or bugs match this view.",
  onRefresh,
}: {
  workspace: WorkspaceAddress;
  items: KnowledgeNode[];
  allNodes?: KnowledgeNode[];
  query: ViewQuery;
  presentation: ViewPresentation;
  blockers?: Record<string, BoardBlockerState>;
  emptyLabel?: string;
  onRefresh?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const { createNode, inspectedNodeId, selectNode, patchNodeSummary } = useWorkspace();
  const options = useMemo(() => ({ query, presentation, nodes: items, allNodes: allNodes ?? items }), [query, presentation, items, allNodes]);
  const columns = useMemo(() => boardColumns(options), [options]);
  const groupBy = boardGroupBy(presentation);
  const movable = canMoveBoardCards(groupBy);
  // Canonical (server-truth) grouping, with no optimistic overlay: the
  // useKanban ListData is now the single source of visual truth, and this
  // is only consulted to seed it and to resync it when props change.
  const groups = useMemo(() => groupBoardNodes(options, {}), [options]);
  const canonicalEntries = useMemo(
    () => columns.flatMap((column) => (groups.get(column.value) ?? []).map((node) => ({ node, column: column.value }))),
    [columns, groups],
  );
  // Canonical refetch — used ONLY where server truth must be re-read: 409
  // conflicts (per the optimistic-UI decision, conflicts are never hidden)
  // and column creates (membership comes from the view resolve). A
  // successful move never calls this: success is silent.
  const refresh = useCallback(() => {
    onRefresh?.();
    if (!onRefresh) router.refresh();
  }, [onRefresh, router]);

  // Drops land here: useKanban calls `setColumn(item, column)` exactly once
  // per cross-column drag (via its internal onInsert/onRootDrop handlers),
  // never for same-column reordering (which only calls list.moveBefore /
  // moveAfter). Both refs are written synchronously inside setColumn — that
  // is what makes the optimistic move race-free: `useKanban` recreates
  // `list`/`updateItem`/... every render, so the resync effect below runs on
  // EVERY commit, including the one right after the drop. If the pending
  // overlay lived in React state (set from an async callback), that commit
  // would still see it empty and snap the card back to its canonical column
  // — the exact "moves, then reverts, then reloads" bug this replaces.
  const pendingDropsRef = useRef<Map<string, string>>(new Map());
  const pendingMovesRef = useRef<Map<string, PendingBoardMove>>(new Map());
  const [initialCardItems] = useState<CardItem[]>(() =>
    canonicalEntries.map(({ node, column }) => ({ id: node.id, column, node })));

  const kanban = useKanban<CardItem>({
    initialItems: initialCardItems,
    getKey: (item) => item.id,
    getColumn: (item) => item.column,
    setColumn: (item, column) => {
      if (item.column !== column) {
        pendingDropsRef.current.set(item.id, column);
        pendingMovesRef.current.set(item.id, {
          value: column,
          baseUpdatedAt: item.node.updated_at,
        });
      }
      return { ...item, column };
    },
  });
  const { list, addItem, removeItem, updateItem } = kanban;

  const moveCard = useCallback(async (node: KnowledgeNode, toColumn: string) => {
    const canonicalColumn = boardValue(node, groupBy, columns);
    const rollback = () => {
      pendingMovesRef.current.delete(node.id);
      updateItem(node.id, { id: node.id, column: canonicalColumn, node });
    };
    const patch = boardMovePatch(node, groupBy, toColumn, columns, (allNodes ?? items).flatMap((item) => item.tags));
    if (!patch) {
      toast.error(`“${groupBy}” is read-only on this board`);
      rollback();
      return;
    }
    const outcome = await persistBoardMove({
      workspace,
      nodeId: node.id,
      ifUpdatedAt: node.updated_at,
      patch,
      rollback,
    });
    if (outcome.status === "ok") {
      // Silent confirm: fold the server-confirmed fields (fresh updated_at
      // included) into the workspace overlay. Canonical props catch up on
      // the next render, the pending move settles in the resync pass, and
      // nothing refetches or repaints — per the optimistic-UI convention,
      // success is invisible.
      if (outcome.node) patchNodeSummary(node.id, boardMoveSummary(outcome.node));
      else pendingMovesRef.current.delete(node.id);
      return;
    }
    toast.error(outcome.status === "conflict"
      ? "This card changed elsewhere. The move was reverted."
      : outcome.status === "forbidden"
        ? "You do not have permission to move this card."
        : "Couldn't move this card. The move was reverted.");
    if (outcome.status === "conflict") refresh();
  }, [allNodes, columns, groupBy, items, patchNodeSummary, refresh, toast, updateItem, workspace]);

  // Process any drops recorded by setColumn during the last render/commit.
  useEffect(() => {
    if (pendingDropsRef.current.size === 0) return;
    const drops = [...pendingDropsRef.current.entries()];
    pendingDropsRef.current.clear();
    for (const [id, toColumn] of drops) {
      const node = list.getItem(id)?.node ?? items.find((candidate) => candidate.id === id);
      if (!node) continue;
      if (boardValue(node, groupBy, columns) === toColumn) {
        pendingMovesRef.current.delete(id);
        continue;
      }
      void moveCard(node, toColumn);
    }
  }, [list, items, groupBy, columns, moveCard]);

  // Resync the kanban ListData from canonical props (new/removed/changed
  // nodes from realtime, summary patches, or RSC refresh) without clobbering
  // moves that are still in flight — `reconcileBoardCard` keeps the
  // optimistic column while canonical is provably stale and settles the
  // overlay the moment canonical confirms or supersedes it.
  useEffect(() => {
    const canonicalIds = new Set(canonicalEntries.map((entry) => entry.node.id));
    for (const item of list.items) {
      if (!canonicalIds.has(item.id)) {
        pendingMovesRef.current.delete(item.id);
        removeItem(item.id);
      }
    }
    for (const { node, column } of canonicalEntries) {
      const existing = list.getItem(node.id);
      const { column: targetColumn, settled } = reconcileBoardCard({
        canonicalColumn: column,
        canonicalUpdatedAt: node.updated_at,
        currentColumn: existing?.column ?? column,
        pending: pendingMovesRef.current.get(node.id),
      });
      if (settled) pendingMovesRef.current.delete(node.id);
      if (!existing) {
        addItem({ id: node.id, column: targetColumn, node });
        continue;
      }
      if (existing.node !== node || existing.column !== targetColumn) {
        updateItem(node.id, { id: node.id, column: targetColumn, node });
      }
    }
  }, [canonicalEntries, list, addItem, removeItem, updateItem]);

  const createInColumn = useCallback(async (value: string) => {
    const draft = deriveBoardCreate(options, value);
    if (!draft.ok) {
      toast.error(draft.reason);
      return;
    }
    const created = await createNode(draft.input);
    if (created) refresh();
  }, [createNode, options, refresh, toast]);

  const { renderDropIndicator } = useKanbanCardPlaceholder({
    renderIndicator: (target) => <Kanban.DropIndicator target={target} />,
  });

  if (items.length === 0) {
    const first = columns[0];
    return (
      <div className="mt-6 rounded-md border border-dashed border-[var(--line)] px-6 py-10 text-center text-[12px] text-[var(--ink-3)]">
        <p>{emptyLabel}</p>
        {first ? (
          <Button
            className="mono mt-3 h-[18px] gap-1 rounded-[4px] border border-[var(--line)] bg-transparent px-[7px] text-[10.5px] text-[var(--ink-3)] hover:bg-[var(--paper-3)]"
            variant="ghost"
            onPress={() => void createInColumn(first.value)}
          >
            <Plus size={10} /> Add the first one
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    // Purely presentational wrapper: adds the always-on-top horizontal
    // scrollbar without touching this board's drag/reconcile logic.
    <BoardTopScrollbar className="mt-4">
      <Kanban hideScrollBar className="mt-0 pb-2" data-board-group-by={groupBy}>
        {columns.map((column) => (
          <BoardColumnRenderer
            key={column.id}
            column={column}
            kanban={kanban}
            movable={movable}
            presentation={presentation}
            blockers={blockers}
            inspectedNodeId={inspectedNodeId}
            selectNode={selectNode}
            renderDropIndicator={renderDropIndicator}
            createDraft={deriveBoardCreate(options, column.value)}
            onCreate={() => void createInColumn(column.value)}
          />
        ))}
      </Kanban>
    </BoardTopScrollbar>
  );
}

function BoardColumnRenderer({
  column,
  kanban,
  movable,
  presentation,
  blockers,
  inspectedNodeId,
  selectNode,
  renderDropIndicator,
  createDraft,
  onCreate,
}: {
  column: BoardColumn;
  kanban: UseKanbanReturn<CardItem>;
  movable: boolean;
  presentation: ViewPresentation;
  blockers: Record<string, BoardBlockerState>;
  inspectedNodeId: string | null;
  selectNode: (id: string) => void;
  renderDropIndicator: UseKanbanColumnOptions["renderDropIndicator"];
  createDraft: ReturnType<typeof deriveBoardCreate>;
  onCreate: () => void;
}) {
  const { items, dragAndDropHooks } = useKanbanColumn(kanban, column.value, { renderDropIndicator });

  return (
    <Kanban.Column aria-label={column.label}>
      <Kanban.ColumnHeader>
        <Kanban.ColumnIndicator style={{ background: STATUS_DOT_COLOR[column.value] ?? "var(--ink-mute)" }} />
        <Kanban.ColumnTitle>{column.label}</Kanban.ColumnTitle>
        <Kanban.ColumnCount>{items.length}</Kanban.ColumnCount>
        <Kanban.ColumnActions>
          <Button
            isIconOnly
            isDisabled={!createDraft.ok}
            onPress={onCreate}
            aria-label={createDraft.ok ? `Add to ${column.label}` : createDraft.reason}
            variant="ghost"
            size="sm"
          >
            <Plus size={14} />
          </Button>
        </Kanban.ColumnActions>
      </Kanban.ColumnHeader>
      <Kanban.ColumnBody>
        <Kanban.CardList
          aria-label={column.label}
          items={items}
          dragAndDropHooks={movable ? dragAndDropHooks : undefined}
          renderEmptyState={() => (movable ? "Drop here" : "No cards")}
        >
          {(item) => (
            <BoardCardItem
              key={item.id}
              item={item}
              blocker={blockers[item.node.id]}
              presentation={presentation}
              selected={inspectedNodeId === item.node.id}
              selectNode={selectNode}
            />
          )}
        </Kanban.CardList>
      </Kanban.ColumnBody>
    </Kanban.Column>
  );
}

/**
 * Wraps a single kanban card with its hover-dwell expansion state: no popup,
 * the card grows in place (`NodeRevealRegion` inside `BoardCard`).
 * `Kanban.Card` stays a direct child of `Kanban.CardList` — same
 * GridListItem base as `ListView.Item` — so onAction/drag/selection keep
 * working untouched.
 */
function BoardCardItem({
  item,
  blocker,
  presentation,
  selected,
  selectNode,
}: {
  item: CardItem;
  blocker?: BoardBlockerState;
  presentation: ViewPresentation;
  selected: boolean;
  selectNode: (id: string) => void;
}) {
  const { address } = useWorkspace();
  const { expanded, onMouseEnter, onMouseLeave } = useHoverDwell();
  const archiveNode = useArchiveNode();
  const { request: requestDelete, dialog: deleteDialog } = useDeleteNode();
  return (
    <Kanban.Card
      textValue={item.node.title}
      onAction={() => selectNode(item.node.id)}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn("group/card relative", selected && "outline-2 outline-[var(--ink)]")}
    >
      <BoardCard
        node={item.node}
        blocker={blocker}
        presentation={presentation}
        selected={selected}
        expanded={expanded}
        workspace={address}
      />
      {/* Archive / Delete without opening the card. The wrapper swallows
          pointer events so the kebab never starts a drag or the card action. */}
      <div
        className="absolute right-1 top-1 opacity-0 transition-opacity group-hover/card:opacity-100 focus-within:opacity-100 motion-reduce:transition-none"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <CardActionsMenu
          ariaLabel={`Actions for ${item.node.title}`}
          actions={nodeActionsFor(item.node)}
          onAction={(key) => {
            if (key === "archive") void archiveNode(item.node);
            if (key === "delete") requestDelete(item.node);
          }}
        />
      </div>
      {deleteDialog}
    </Kanban.Card>
  );
}

function BoardCard({
  node,
  blocker,
  presentation,
  selected,
  expanded,
  workspace,
}: {
  node: KnowledgeNode;
  blocker?: BoardBlockerState;
  presentation: ViewPresentation;
  selected: boolean;
  expanded: boolean;
  workspace: WorkspaceAddress;
}) {
  const fields = boardCardFields(presentation);
  const tags = getNodeTags(node);
  const source = typeof node.data.source === "string" ? node.data.source : null;
  // A summary row carries the counts; a full node (optimistic create, panel
  // patch) carries the list — the helper reads whichever is there.
  const progress = nodeSubtaskProgress({ data: node.data, subtasks: (node as Partial<NodeSummary>).subtasks });
  const Icon = node.kind === "bug" ? Bug : CheckSquare;
  return (
    <div
      data-renderer="board"
      data-node-id={node.id}
      aria-selected={selected}
      className="group flex w-full flex-col gap-2 text-left text-[12px]"
    >
      <div className="flex items-start gap-1.5">
        {fields.has("kind") ? <Icon size={11} className="mt-[3px] shrink-0 text-[var(--ink-3)] group-hover:text-[var(--ink)]" aria-label={node.kind} /> : null}
        <span className="line-clamp-3 text-[var(--ink)]">{node.title}</span>
      </div>
      <div className="mono flex flex-wrap items-center gap-1 text-[10px] text-[var(--ink-3)]">
        {fields.has("priority") && node.priority ? (
          <Chip size="sm" variant="tertiary" className="rounded-full px-1.5 py-0 text-[9px] text-[var(--ink-mute)]">
            <Chip.Label>{node.priority}</Chip.Label>
          </Chip>
        ) : null}
        {fields.has("tags") ? tags.slice(0, 3).map((tag) => (
          <Chip key={tag} size="sm" variant="tertiary" className="gap-1 rounded-full px-1.5 py-0 text-[9px] text-[var(--ink-mute)]">
            <Hash size={9} /> <Chip.Label>{tag}</Chip.Label>
          </Chip>
        )) : null}
        {fields.has("subtasks") && progress ? (
          <Chip
            size="sm"
            variant="tertiary"
            className={cn("gap-1 rounded-full px-1.5 py-0 text-[9px] text-[var(--ink-mute)]", progress.done === progress.total && "text-[var(--ink-3)]")}
            title={`${progress.done} of ${progress.total} subtasks done`}
          >
            <ListChecks size={9} /> <Chip.Label>{progress.done}/{progress.total}</Chip.Label>
          </Chip>
        ) : null}
        {fields.has("blockers") && blocker?.total ? (
          <Chip
            size="sm"
            variant="tertiary"
            className={cn("gap-1 rounded-full px-1.5 py-0 text-[9px] text-[var(--ink-mute)]", blocker.active > 0 && "text-[var(--warn)]")}
            title={`${blocker.active} active of ${blocker.total} blockers`}
          >
            <AlertTriangle size={9} /> <Chip.Label>{blocker.active}/{blocker.total}</Chip.Label>
          </Chip>
        ) : null}
        {fields.has("due_date") && node.due_date ? (
          <Chip size="sm" variant="tertiary" className="gap-1 rounded-full px-1.5 py-0 text-[9px] text-[var(--ink-mute)]" title={node.due_date}>
            <CalendarDays size={9} /> <Chip.Label>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(node.due_date))}</Chip.Label>
          </Chip>
        ) : null}
        {fields.has("provenance") && (source || node.created_by) ? (
          <Chip
            size="sm"
            variant="tertiary"
            className="gap-1 rounded-full px-1.5 py-0 text-[9px] text-[var(--ink-mute)]"
            title={node.created_by ? `Created by ${node.created_by}` : undefined}
          >
            <CircleDot size={9} /> <Chip.Label>{source ?? "workspace"}</Chip.Label>
          </Chip>
        ) : null}
        {fields.has("provenance") ? <span className="ml-auto">{formatRelative(node.updated_at)}</span> : null}
      </div>
      <NodeRevealRegion
        open={expanded}
        nodeId={node.id}
        workspace={workspace}
        tags={tags}
        status={node.status}
      />
    </div>
  );
}
