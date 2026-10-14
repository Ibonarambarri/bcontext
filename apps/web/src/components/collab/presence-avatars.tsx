"use client";

/**
 * Tiny faces for the peers currently viewing a node (used in the node
 * inspector). Reads workspace presence from the realtime provider on every
 * render — cheap because the peer list is small (and presence updates are
 * throttled inside the provider). Each peer is their blobatar, the same one
 * the roster and the editor strip show. Styles live in `globals.css`
 * (`.presence-chip*`).
 */
import { useMemo } from "react";
import { Avatar } from "@heroui/react";
import { useWorkspacePresence } from "@/lib/collab/workspace-realtime";
import { PersonAvatar } from "@/components/person-avatar";

export function PresenceAvatars({ pageId }: { pageId: string }) {
  const peers = useWorkspacePresence();
  const here = useMemo(
    () => peers.filter((p) => p.pageId === pageId),
    [peers, pageId],
  );

  if (here.length === 0) return null;
  const visible = here.slice(0, 3);
  const overflow = here.length - visible.length;

  return (
    <span className="presence-chip-stack" aria-label={`${here.length} viewing`}>
      {visible.map((p) => (
        <span key={p.presenceKey} className="presence-chip" title={p.name}>
          <PersonAvatar user={{ id: p.userId }} size={14} />
        </span>
      ))}
      {overflow > 0 && (
        <Avatar
          className="presence-chip presence-chip-overflow"
          style={{ width: 14, height: 14 }}
          title={`+${overflow} more`}
        >
          <Avatar.Fallback style={{ background: "transparent" }}>+{overflow}</Avatar.Fallback>
        </Avatar>
      )}
    </span>
  );
}
