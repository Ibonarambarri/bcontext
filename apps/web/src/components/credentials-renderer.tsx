"use client";

/**
 * CredentialsRenderer — the workspace's vault: one card per `credential` node
 * in the view's scope, grouped by environment so prod is never a row away
 * from local. Mounted by `view-canvas.tsx` for `credentials`-renderer views.
 *
 * Each card says which credential it is (type, environment, service, tags),
 * then its fields — masked by default, with reveal, copy and the `bx://`
 * reference on every one. The title opens the node in the floating panel,
 * where it is edited.
 *
 * The `list` field preset carried by saved views never includes `data`
 * (fields live there, and no preset projects it — see
 * `presetForRenderer`/`node-fields.ts`), so each card's credential is fetched
 * lazily, once per node, from `GET /api/nodes/[id]/inspector`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, KeyRound } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Chip, ScrollShadow } from "@heroui/react";
import type { SavedView } from "@bcontext-dev/contract/views/types";
import {
  CREDENTIAL_ENVIRONMENTS,
  CREDENTIAL_ENVIRONMENT_LABELS,
  readCredential,
  type Credential,
  type CredentialEnvironment,
} from "@bcontext-dev/contract/credentials";
import { getNodeTags } from "@bcontext-dev/contract/types";
import { useWorkspace } from "./workspace-context";
import { ViewSkeleton } from "@/components/skeletons";
import { CredentialBody, CredentialIdentity } from "./credential-node-view";
import { workspaceApiRef } from "@/web/workspace-url";

/** Prod first: the one you most need to find, and the one you most need to not confuse. */
const ENV_ORDER: Array<CredentialEnvironment | "none"> = [...[...CREDENTIAL_ENVIRONMENTS].reverse(), "none"];

export function CredentialsRenderer({ view }: { view: SavedView }) {
  const { address, nodes, activeViewResult, inspectedNodeId, selectNode } = useWorkspace();
  const [credentialByNode, setCredentialByNode] = useState<Record<string, Credential>>({});
  const fetchedRef = useRef(new Set<string>());

  const scopedNodes = useMemo(() => {
    if (!activeViewResult) return [];
    const allowed = new Set(activeViewResult.node_ids);
    return nodes.filter((node) => node.kind === "credential" && allowed.has(node.id));
  }, [activeViewResult, nodes]);

  useEffect(() => {
    for (const node of scopedNodes) {
      if (fetchedRef.current.has(node.id)) continue;
      fetchedRef.current.add(node.id);
      void (async () => {
        try {
          const response = await fetch(
            `/api/nodes/${encodeURIComponent(node.id)}/inspector?workspace=${encodeURIComponent(workspaceApiRef(address))}&scope=preview`,
          );
          if (!response.ok) return;
          const payload = (await response.json()) as { node?: { data?: Record<string, unknown> } };
          setCredentialByNode((previous) => ({ ...previous, [node.id]: readCredential(payload.node?.data) }));
        } catch {
          // best-effort — the card falls back to an empty-fields state
        }
      })();
    }
  }, [scopedNodes, address]);

  // Each card's credential arrives from its own lazy fetch, so for the first
  // moment nothing knows its environment. Grouping then would print
  // "NO ENVIRONMENT 10" over the whole vault and correct itself a beat later
  // — a heading that is briefly wrong is worse than no heading, so the list
  // stays flat until every card knows where it belongs.
  const resolved = scopedNodes.length > 0 && scopedNodes.every((node) => credentialByNode[node.id]);

  const groups = useMemo(() => {
    const byEnv = new Map<CredentialEnvironment | "none", typeof scopedNodes>();
    for (const node of scopedNodes) {
      const env = credentialByNode[node.id]?.environment ?? "none";
      const bucket = byEnv.get(env) ?? [];
      bucket.push(node);
      byEnv.set(env, bucket);
    }
    return ENV_ORDER.flatMap((env) => {
      const bucket = byEnv.get(env);
      return bucket && bucket.length > 0 ? [{ env, nodes: bucket }] : [];
    });
  }, [scopedNodes, credentialByNode]);

  if (!activeViewResult) return <ViewSkeleton />;

  return (
    <ScrollShadow className="scroll h-full overflow-y-auto" role="region" aria-label={view.name}>
      <div className="w-full px-4 pb-16 pt-4 sm:px-8 sm:pt-5">
        <p className="mb-3 text-[12px] text-[var(--ink-3)]">
          {scopedNodes.length} {scopedNodes.length === 1 ? "credential" : "credentials"}
          {activeViewResult.scope.truncated ? " · limited result" : ""}
        </p>

        {scopedNodes.length === 0 ? (
          <EmptyState className="mt-4 min-h-[320px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-6 py-12">
            <EmptyState.Header>
              <EmptyState.Media variant="icon">
                <KeyRound size={20} />
              </EmptyState.Media>
              <EmptyState.Title className="text-[16px] text-[var(--ink)]">No credentials yet</EmptyState.Title>
              <EmptyState.Description className="max-w-[430px]">
                One node is one credential — an API key, a login, a key pair. Create a Credential
                node, pick its type and say which environment it belongs to.
              </EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-6">
            {(resolved ? groups : [{ env: "none" as const, nodes: scopedNodes }]).map((group) => (
              <section key={group.env} aria-label={group.env === "none" ? "No environment" : group.env}>
                {resolved ? (
                  <h2 className="mono mb-2 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">
                    {group.env === "none" ? "No environment" : CREDENTIAL_ENVIRONMENT_LABELS[group.env]}
                    <span className="ml-1.5 text-[var(--ink-3)]">{group.nodes.length}</span>
                  </h2>
                ) : null}
                <div className="flex flex-col gap-3">
                  {group.nodes.map((node) => {
                    const credential = credentialByNode[node.id];
                    const tags = getNodeTags(node);
                    return (
                      <div
                        key={node.id}
                        className={
                          "w-full rounded-xl border p-3 " +
                          (inspectedNodeId === node.id
                            ? "border-[var(--ink)] bg-[var(--paper-3)]"
                            : "border-[var(--line)] bg-[var(--paper)]")
                        }
                      >
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => selectNode(node.id)}
                            className="flex min-w-0 items-center gap-2 text-left"
                          >
                            <KeyRound size={14} className="shrink-0 text-[var(--ink-3)]" aria-hidden />
                            <span className="truncate text-[13.5px] font-medium text-[var(--ink)] hover:underline">
                              {node.title}
                            </span>
                          </button>
                          {credential ? <CredentialIdentity credential={credential} /> : null}
                          {tags.length > 0 ? (
                            <div className="ml-auto flex flex-wrap items-center gap-1">
                              {tags.slice(0, 4).map((tag) => (
                                <Chip key={tag} size="sm" variant="soft" className="gap-0.5 text-[10px]">
                                  <Hash size={8} className="opacity-60" />
                                  <Chip.Label>{tag}</Chip.Label>
                                </Chip>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        {credential ? (
                          <CredentialBody credential={credential} nodeId={node.id} nodeTitle={node.title} />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </ScrollShadow>
  );
}
