"use client";

/**
 * Past conversations — the left rail of the Nexo page, and the same list folded
 * into the panel behind its History button.
 *
 * Conversations are opened server-side on the first turn, so this list fills
 * itself: nothing to save, nothing lost by closing the window.
 */
import { useEffect } from "react";
import { ChatListView } from "@/components/ui/chat/chat-list-view";
import { EmptyState } from "@/components/ui/empty-state";
import { Button, Tooltip } from "@heroui/react";
import { MessageSquare, Plus, Trash2 } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";
import { useNexo } from "./nexo-provider";

export function NexoHistory({
  variant,
  onPick,
}: {
  variant: "panel" | "page";
  onPick?: () => void;
}) {
  const {
    conversations,
    conversationsLoading,
    conversationId,
    refreshConversations,
    openConversation,
    deleteConversation,
    startNewConversation,
    persona,
  } = useNexo();

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  const page = variant === "page";

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        page ? "h-full w-[264px] shrink-0 border-r border-border" : "flex-1",
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 pl-4 pr-2">
        <span className="flex-1 text-sm font-medium text-foreground">Conversations</span>
        <Tooltip delay={400}>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="New conversation"
            onPress={() => {
              startNewConversation();
              onPick?.();
            }}
          >
            <Plus size={14} />
          </Button>
          <Tooltip.Content>New conversation</Tooltip.Content>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {conversations.length === 0 ? (
          <EmptyState size="sm" className="pt-6">
            <EmptyState.Media variant="icon">
              <MessageSquare size={16} />
            </EmptyState.Media>
            <EmptyState.Header>
              <EmptyState.Title>
                {conversationsLoading ? "Loading" : "Nothing yet"}
              </EmptyState.Title>
              <EmptyState.Description>
                {conversationsLoading
                  ? "Fetching your conversations."
                  : `Say something to ${persona?.name ?? "Nexo"} and it will show up here.`}
              </EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <ChatListView
            aria-label="Conversations"
            density="compact"
            items={conversations}
            selectionMode="none"
            onAction={(key) => {
              void openConversation(String(key));
              onPick?.();
            }}
          >
            {(conversation) => (
              <ChatListView.Item
                id={conversation.id}
                textValue={conversation.title ?? "Untitled"}
                data-current={conversation.id === conversationId ? "" : undefined}
                className={cn(
                  conversation.id === conversationId && "bg-surface-secondary shadow-surface",
                )}
              >
                <ChatListView.ItemContent>
                  <ChatListView.Icon>
                    <MessageSquare size={13} />
                  </ChatListView.Icon>
                  <ChatListView.Text>
                    <ChatListView.Title>
                      {conversation.title?.trim() || "Untitled"}
                    </ChatListView.Title>
                    <ChatListView.Preview>
                      {relativeTime(conversation.updated_at)}
                    </ChatListView.Preview>
                  </ChatListView.Text>
                  <ChatListView.Meta>
                    <Tooltip delay={400}>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label="Delete conversation"
                        onPress={() => void deleteConversation(conversation.id)}
                      >
                        <Trash2 size={12} />
                      </Button>
                      <Tooltip.Content>Delete</Tooltip.Content>
                    </Tooltip>
                  </ChatListView.Meta>
                </ChatListView.ItemContent>
              </ChatListView.Item>
            )}
          </ChatListView>
        )}
      </div>
    </div>
  );
}

/** "2h ago" beats a timestamp nobody reads. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
