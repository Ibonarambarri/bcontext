"use client";

/**
 * The workspace's Nexos, read once per mount and kept as local state the
 * caller can update optimistically. The API makes sure the general Nexo
 * exists on every list call, so an empty answer only ever means "not loaded"
 * or "failed".
 *
 * Used by the Nexos page (the grid).
 */
import { useCallback, useEffect, useState } from "react";
import { nexosApi } from "@/lib/nexos/api";
import type { NexoListItem } from "@bcontext-dev/contract/nexos";
import type { WorkspaceAddress } from "@/web/workspace-url";

/** General first, then the specialists in the order they were made. */
export function sortNexos<T extends { is_general: boolean; created_at: string }>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    a.is_general !== b.is_general ? (a.is_general ? -1 : 1) : a.created_at.localeCompare(b.created_at),
  );
}

export function useNexos(workspace: WorkspaceAddress) {
  const [nexos, setNexos] = useState<NexoListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setNexos(sortNexos(await nexosApi.list(workspace)));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspace]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { nexos, setNexos, error, reload };
}
