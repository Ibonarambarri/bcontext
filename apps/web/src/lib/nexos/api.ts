/**
 * The browser's side of `/api/nexos…` and `/api/org/ai-keys`: one place that
 * knows the URLs, how a workspace is named to them (`?workspace=<org>~<ws>`)
 * and how a refusal becomes a sentence. Shapes are the contract's
 * (`@bcontext-dev/contract/nexos`).
 *
 * Called by every Nexos component (`src/components/nexos/*`) and the
 * organization panel's AI keys section. It holds no state and caches nothing
 * — the components own their optimistic copies — so a route rename on the API
 * is a one-file change here. Relative `/api/…` URLs only: the web has no data
 * of its own.
 */
import type {
  CreateNexoBody,
  ListNexosResponse,
  NexoBinding,
  NexoBindingMode,
  NexoBindingsResponse,
  NexoChannelsResponse,
  NexoDetailResponse,
  NexoInboxAction,
  NexoInboxItem,
  NexoInboxResponse,
  NexoInboxStatus,
  NexoListItem,
  NexoPromptPreviewResponse,
  NexoResponse,
  NexoRun,
  NexoRunsResponse,
  NexoTools,
  OrgAiKey,
  OrgAiKeyProvider,
  OrgAiKeysResponse,
  UpdateNexoBody,
  Nexo,
} from "@bcontext-dev/contract/nexos";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

/**
 * A Nexo as its page holds it: the record plus what the detail call returns
 * beside it, kept in one object so an optimistic patch touches one state.
 */
export type NexoView = Nexo & Omit<NexoDetailResponse, "nexo">;

/** A failed call, carrying the API's own words when it gave any. */
export class NexosApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error.replace(/_/g, " ")
          : `HTTP ${res.status}`;
    throw new NexosApiError(message, res.status);
  }
  return body as T;
}

function q(ws: WorkspaceAddress, extra?: Record<string, string | undefined>): string {
  const params = new URLSearchParams({ workspace: workspaceApiRef(ws) });
  for (const [key, value] of Object.entries(extra ?? {})) if (value) params.set(key, value);
  return params.toString();
}

const enc = encodeURIComponent;
const json = (body: unknown) => JSON.stringify(body);

export const nexosApi = {
  list: (ws: WorkspaceAddress): Promise<NexoListItem[]> =>
    call<ListNexosResponse>(`/api/nexos?${q(ws)}`).then((b) => b.nexos ?? []),

  /** The prompt the answers would produce, without creating anything. */
  preview: (ws: WorkspaceAddress, body: Omit<CreateNexoBody, "preview">) =>
    call<NexoPromptPreviewResponse>(`/api/nexos?${q(ws)}`, {
      method: "POST",
      body: json({ ...body, preview: true }),
    }),

  create: (ws: WorkspaceAddress, body: Omit<CreateNexoBody, "preview">): Promise<Nexo> =>
    call<NexoResponse>(`/api/nexos?${q(ws)}`, { method: "POST", body: json(body) }).then((b) => b.nexo),

  get: (ws: WorkspaceAddress, id: string): Promise<NexoView> =>
    call<NexoDetailResponse>(`/api/nexos/${enc(id)}?${q(ws)}`).then(({ nexo, ...rest }) => ({
      ...nexo,
      ...rest,
    })),

  update: (ws: WorkspaceAddress, id: string, patch: UpdateNexoBody): Promise<Nexo> =>
    call<NexoResponse>(`/api/nexos/${enc(id)}?${q(ws)}`, { method: "PATCH", body: json(patch) }).then(
      (b) => b.nexo,
    ),

  remove: (ws: WorkspaceAddress, id: string) =>
    call<unknown>(`/api/nexos/${enc(id)}?${q(ws)}`, { method: "DELETE" }),

  regeneratePrompt: (ws: WorkspaceAddress, id: string): Promise<Nexo> =>
    call<NexoResponse>(`/api/nexos/${enc(id)}/prompt?${q(ws)}`, { method: "POST" }).then((b) => b.nexo),

  /**
   * The Slack channels an install can see, for the channel picker. A 400
   * `unsupported` (not Slack) or any failure leaves the caller on typed ids.
   */
  channels: (ws: WorkspaceAddress, installId: string): Promise<NexoChannelsResponse> =>
    call<NexoChannelsResponse>(`/api/nexos/channels?${q(ws, { install_id: installId })}`),

  /**
   * One binding per channel, or one for the whole install when `channels` is
   * empty. `scope` rides along on every row (e.g. `channel_names`, so the tab
   * can show names without asking Slack again).
   */
  bind: (
    ws: WorkspaceAddress,
    id: string,
    input: { install_id: string; channels: string[]; mode: NexoBindingMode; scope?: Record<string, unknown> },
  ): Promise<NexoBinding[]> =>
    call<NexoBindingsResponse>(`/api/nexos/${enc(id)}/bindings?${q(ws)}`, {
      method: "POST",
      body: json(input),
    }).then((b) => b.bindings ?? []),

  unbind: (ws: WorkspaceAddress, id: string, bindingId: string) =>
    call<unknown>(`/api/nexos/${enc(id)}/bindings/${enc(bindingId)}?${q(ws)}`, { method: "DELETE" }),

  tools: (ws: WorkspaceAddress, id: string): Promise<NexoTools> =>
    call<{ tools: NexoTools }>(`/api/nexos/${enc(id)}/tools?${q(ws)}`).then((b) => b.tools),

  /** The full desired set: anything left out is revoked. */
  setTools: (ws: WorkspaceAddress, id: string, input: { capability_ids: string[]; bundle_ids: string[] }) =>
    call<{ tools: NexoTools }>(`/api/nexos/${enc(id)}/tools?${q(ws)}`, {
      method: "PUT",
      body: json(input),
    }).then((b) => b.tools),

  runs: (ws: WorkspaceAddress, id: string): Promise<NexoRun[]> =>
    call<NexoRunsResponse>(`/api/nexos/${enc(id)}/runs?${q(ws)}`).then((b) => b.runs ?? []),

  run: (ws: WorkspaceAddress, id: string, instruction?: string) =>
    call<{ run_id: string; status: NexoRun["status"]; output_md?: string | null }>(`/api/nexos/${enc(id)}/run?${q(ws)}`, {
      method: "POST",
      body: json(instruction ? { instruction } : {}),
    }),

  inbox: (ws: WorkspaceAddress, filter: { nexoId?: string; status?: NexoInboxStatus }): Promise<NexoInboxItem[]> =>
    call<NexoInboxResponse>(`/api/nexos/inbox?${q(ws, { nexo_id: filter.nexoId, status: filter.status })}`).then(
      (b) => b.items ?? [],
    ),

  resolve: (ws: WorkspaceAddress, itemId: string, action: NexoInboxAction, text?: string) =>
    call<{ item?: NexoInboxItem }>(`/api/nexos/inbox/${enc(itemId)}?${q(ws)}`, {
      method: "POST",
      body: json(text != null ? { action, text } : { action }),
    }).then((b) => b.item ?? null),
};

/** The per-Nexo chat endpoints, for the conversation session. */
export function nexoChatUrls(ws: WorkspaceAddress, id: string) {
  return {
    chat: `/api/nexos/${enc(id)}/chat?${q(ws)}`,
    sessions: `/api/nexos/${enc(id)}/sessions?${q(ws)}`,
  };
}

/** BYOK keys of an organization; admins only, the key itself never comes back. */
export const orgAiKeysApi = {
  list: (org: string): Promise<OrgAiKey[]> =>
    call<OrgAiKeysResponse>(`/api/org/ai-keys?org=${enc(org)}`).then((b) => b.keys ?? []),
  put: (org: string, provider: OrgAiKeyProvider, apiKey: string): Promise<OrgAiKey> =>
    call<{ key: OrgAiKey }>(`/api/org/ai-keys?org=${enc(org)}`, {
      method: "PUT",
      body: json({ provider, api_key: apiKey }),
    }).then((b) => b.key),
  remove: (org: string, provider: OrgAiKeyProvider) =>
    call<unknown>(`/api/org/ai-keys?org=${enc(org)}&provider=${enc(provider)}`, { method: "DELETE" }),
};
