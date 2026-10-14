"use client";

/**
 * A Nexo's Inbox tab: what it needs a person for.
 *
 *   · draft replies (autonomy `draft`): the text it would send, editable in
 *     place — Approve sends it as written, Send edited sends your version,
 *     Reject drops it. Sending goes through the binding it came from, on the
 *     API (`POST /api/nexos/inbox/:id`).
 *   · escalations and approvals: what happened and why it stopped; Done
 *     closes them once you have dealt with it.
 *
 * `?item=<id>` (the escalation email's link) scrolls to that item and rings
 * it, switching to Resolved when someone already dealt with it.
 *
 * What a Nexo writes is Markdown, rendered as its chat renders it
 * (`NexoRichText`): links to `/n/<id>` open the node beside the inbox.
 *
 * Resolving is optimistic — the item leaves the open list at once and comes
 * back with a toast if the API refuses. Nothing here is destructive enough to
 * confirm: a rejected draft was never sent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Send, X } from "lucide-react";
import { Button, Chip, Tabs } from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { formatRelative } from "@bcontext-dev/contract/utils";
import { ListSkeleton } from "@/components/skeletons";
import { useToast } from "@/components/workspace-context";
import type { NexoInboxAction, NexoInboxItem } from "@bcontext-dev/contract/nexos";
import { nexosApi, type NexoView } from "@/lib/nexos/api";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { INBOX_KIND_COPY } from "./nexo-copy";
import { NexoFace } from "./nexo-face";
import { NexoRichText } from "./nexo-rich-text";
import { TextQuestion } from "./nexo-fields";

type Lens = "open" | "resolved";

const RESOLVED_LABEL: Record<string, string> = {
  approved: "Sent",
  edited: "Sent, edited",
  rejected: "Rejected",
  done: "Done",
};

export function NexoInboxTab({
  workspace,
  nexo,
  focusItemId,
  onOpenCountChange,
}: {
  workspace: WorkspaceAddress;
  nexo: NexoView;
  /** An item to scroll to and ring (`?item=`), from a notification link. */
  focusItemId?: string | null;
  onOpenCountChange: (count: number) => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<NexoInboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>("open");

  const load = useCallback(async () => {
    try {
      setItems(await nexosApi.inbox(workspace, { nexoId: nexo.id }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [nexo.id, workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  // Once per focused id: after that the person moves freely between lenses.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!items || !focusItemId || focused.current === focusItemId) return;
    const item = items.find((i) => i.id === focusItemId);
    if (!item) return;
    focused.current = focusItemId;
    setLens(item.status === "open" ? "open" : "resolved");
    requestAnimationFrame(() =>
      document.getElementById(inboxItemDomId(focusItemId))?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  }, [items, focusItemId]);

  const open = useMemo(() => (items ?? []).filter((i) => i.status === "open"), [items]);
  const resolved = useMemo(() => (items ?? []).filter((i) => i.status !== "open"), [items]);

  useEffect(() => {
    if (items) onOpenCountChange(open.length);
  }, [items, open.length, onOpenCountChange]);

  const resolve = async (item: NexoInboxItem, action: NexoInboxAction, text?: string) => {
    const before = items;
    const status = action === "approve" ? "approved" : action === "edit" ? "edited" : action === "reject" ? "rejected" : "done";
    setItems((current) =>
      (current ?? []).map((i) => (i.id === item.id ? { ...i, status, resolved_at: new Date().toISOString() } : i)),
    );
    try {
      const saved = await nexosApi.resolve(workspace, item.id, action, text);
      if (saved) setItems((current) => (current ?? []).map((i) => (i.id === item.id ? { ...i, ...saved } : i)));
      if (action === "approve" || action === "edit") toast.info("Reply sent.");
    } catch (e) {
      setItems(before);
      toast.error(`Couldn't ${action === "reject" ? "reject" : action === "done" ? "close" : "send"} it: ${(e as Error).message}`);
    }
  };

  const shown = lens === "open" ? open : resolved;

  return (
    <section aria-labelledby="nexo-inbox">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 id="nexo-inbox" className="m-0 text-[15px] font-medium">
            Inbox
          </h2>
          <p className="mt-0.5 text-[12px] text-[var(--ink-3)]">
            Replies waiting for your OK, and what {nexo.name} could not settle on its own.
          </p>
        </div>
        <span className="ml-auto" />
        <Tabs selectedKey={lens} onSelectionChange={(key) => setLens(key as Lens)}>
          <Tabs.ListContainer>
            <Tabs.List aria-label="Which items">
              <Tabs.Tab id="open">
                Open{open.length ? <span className="ml-1 tabular-nums text-muted">{open.length}</span> : null}
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="resolved">
                Resolved
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </div>

      {error && !items ? (
        <p role="alert" className="mt-4 text-[12.5px] text-danger">
          {error}
        </p>
      ) : !items ? (
        <ListSkeleton rows={3} />
      ) : shown.length === 0 ? (
        <EmptyState className="mt-5 min-h-[240px] rounded-[14px] border border-dashed border-[var(--line)] bg-[var(--paper-2)]">
          <EmptyState.Header>
            <EmptyState.Media>
              <NexoFace name={nexo.name} general={nexo.is_general} size={44} animate="always" />
            </EmptyState.Media>
            <EmptyState.Title>{lens === "open" ? "All clear" : "Nothing resolved yet"}</EmptyState.Title>
            <EmptyState.Description className="max-w-[380px]">
              {lens === "open"
                ? nexo.autonomy === "draft"
                  ? "Drafts land here for you to approve before anything is sent."
                  : "When it needs you, it says so here and lets you know."
                : "What you approve, edit, reject or close stays here for the record."}
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      ) : (
        <ul className="mt-5 flex list-none flex-col gap-3 p-0">
          {shown.map((item) => (
            <InboxCard key={item.id} item={item} focused={item.id === focusItemId} onResolve={(action, text) => void resolve(item, action, text)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function inboxItemDomId(id: string): string {
  return `nexo-inbox-${id}`;
}

function InboxCard({
  item,
  focused,
  onResolve,
}: {
  item: NexoInboxItem;
  focused: boolean;
  onResolve: (action: NexoInboxAction, text?: string) => void;
}) {
  const original = typeof item.payload?.draft_text === "string" ? item.payload.draft_text : "";
  const [draft, setDraft] = useState(original);
  const isDraft = item.kind === "draft_reply";
  const isOpen = item.status === "open";
  const edited = draft.trim() !== original.trim();
  const channel = typeof item.payload?.channel === "string" ? item.payload.channel : null;

  return (
    <li
      id={inboxItemDomId(item.id)}
      className={`fade-in scroll-mt-24 rounded-[14px] border bg-[var(--paper)] p-4 ${
        focused ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/25" : "border-[var(--line)]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="soft" color={item.kind === "escalation" ? "warning" : "accent"}>
          {INBOX_KIND_COPY[item.kind]}
        </Chip>
        <h3 className="m-0 min-w-0 flex-1 basis-[200px] truncate text-[13.5px] font-medium text-foreground" title={item.title}>
          {item.title}
        </h3>
        <span className="shrink-0 text-[11.5px] tabular-nums text-muted">
          {channel ? `#${channel} · ` : ""}
          {formatRelative(item.created_at)}
        </span>
      </div>
      {item.body_md ? <NexoRichText markdown={item.body_md} className="mt-2" /> : null}

      {isDraft && isOpen ? (
        <div className="mt-3">
          <TextQuestion label="Reply" value={draft} onChange={setDraft} rows={4} />
        </div>
      ) : isDraft && original ? (
        <blockquote className="m-0 mt-3 border-l-2 border-[var(--line-strong)] pl-3 text-[12.5px] leading-[1.6] text-[var(--ink-3)]">
          {original}
        </blockquote>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {isOpen ? (
          isDraft ? (
            <>
              <Button size="sm" variant="ghost" className="gap-1.5" onPress={() => onResolve("reject")}>
                <X size={13} />
                Reject
              </Button>
              <span className="flex-1" />
              {edited ? (
                <Button size="sm" className="gap-1.5" onPress={() => onResolve("edit", draft)} isDisabled={!draft.trim()}>
                  <Send size={13} />
                  Send edited
                </Button>
              ) : (
                <Button size="sm" className="gap-1.5" onPress={() => onResolve("approve")}>
                  <Send size={13} />
                  Approve and send
                </Button>
              )}
            </>
          ) : (
            <>
              <span className="flex-1" />
              <Button size="sm" variant="outline" className="gap-1.5" onPress={() => onResolve("done")}>
                <Check size={13} />
                Done
              </Button>
            </>
          )
        ) : (
          <span className="text-[11.5px] text-muted">
            {RESOLVED_LABEL[item.status] ?? item.status}
            {item.resolved_at ? ` · ${formatRelative(item.resolved_at)}` : ""}
          </span>
        )}
      </div>
    </li>
  );
}
