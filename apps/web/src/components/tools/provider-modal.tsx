"use client";

/**
 * Add/Edit tool provider dialog (MCP server or workflow tool), driven by
 * `tool-providers-view.tsx`, which owns the form state, discovery and save.
 * This file owns the OAuth handshake: `POST /api/capabilities/oauth/start`
 * opens the provider's consent page in a popup, `/oauth/status` is polled
 * until the attempt is authorised, and discovery then runs with the attempt
 * id. Every generation of the handshake is numbered so a stale poll can
 * never resurrect a cancelled attempt.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Server,
  Webhook,
} from "lucide-react";
import { Button, Input as HeroInput, Modal, TextField } from "@heroui/react";
import {
  type AuthType,
  type ProviderForm,
  connectionFingerprint,
  declaredLabel,
  inferProviderMetadata,
  isProviderConnectionValid,
  isValidHttpsProviderEndpoint,
} from "./provider-shared";

type OAuthPhase = "idle" | "starting" | "waiting" | "discovering" | "ready" | "failed" | "expired";

interface OAuthUiState {
  phase: OAuthPhase;
  attemptId: string;
  authorizationUrl: string;
  authorizationHost: string;
  message: string;
}

const EMPTY_OAUTH: OAuthUiState = {
  phase: "idle",
  attemptId: "",
  authorizationUrl: "",
  authorizationHost: "",
  message: "",
};

export function ProviderModal({ workspaceId, form, saving, error, onChange, onClose, onBack, onDiscover, onSave }: {
  workspaceId: string;
  form: ProviderForm;
  saving: boolean;
  error: string | null;
  onChange: (form: ProviderForm) => void;
  onClose: () => void;
  /** Present while adding: returns to the provider-type selector step. */
  onBack?: () => void;
  onDiscover: (form?: ProviderForm | null) => Promise<boolean>;
  onSave: () => void;
}) {
  const popupRef = useRef<Window | null>(null);
  const mountedRef = useRef(true);
  const oauthGenerationRef = useRef(0);
  const oauthRef = useRef<OAuthUiState>(EMPTY_OAUTH);
  const latestRef = useRef({ form, onChange, onDiscover });
  const lastAutoDiscoveryRef = useRef("");
  const [oauth, setOAuth] = useState<OAuthUiState>(EMPTY_OAUTH);
  const [authConfirmed, setAuthConfirmed] = useState(Boolean(form.capabilityId));
  oauthRef.current = oauth;
  latestRef.current = { form, onChange, onDiscover };

  const editing = Boolean(form.capabilityId);
  const isMcp = form.type === "mcp_server";

  const cancelOAuth = useCallback(() => {
    oauthGenerationRef.current += 1;
    popupRef.current?.close();
    popupRef.current = null;
    const attemptId = oauth.attemptId;
    setOAuth(EMPTY_OAUTH);
    if (attemptId) {
      const query = new URLSearchParams({ workspace_id: workspaceId, attempt_id: attemptId });
      void fetch(`/api/capabilities/oauth/status?${query}`, { method: "DELETE" }).catch(() => {});
    }
  }, [oauth.attemptId, workspaceId]);

  const patch = (next: Partial<ProviderForm>, resetAuthorization = false) => {
    if (resetAuthorization) cancelOAuth();
    onChange({
      ...form,
      ...next,
      ...(resetAuthorization ? {
        oauthAttemptId: "",
        tools: [],
        logoUrl: "",
        logoSource: "",
        declaredMetadata: {},
        credentialMode: "replace" as const,
        credentialConfigured: false,
      } : {}),
    });
  };

  const changeEndpoint = (endpointUrl: string) => {
    const inferred = inferProviderMetadata(endpointUrl);
    patch({
      endpointUrl,
      credentialMode: "replace",
      credentialConfigured: false,
      ...(inferred ?? { title: "", provider: "", description: "" }),
    }, true);
  };

  const selectAuth = (authType: AuthType) => {
    setAuthConfirmed(true);
    if (authType !== form.authType) patch({
      authType,
      credentialMode: "replace",
      credentialConfigured: authType === "none",
    }, true);
  };

  const close = () => {
    if (saving) return;
    cancelOAuth();
    onClose();
  };

  const back = () => {
    if (saving || !onBack) return;
    cancelOAuth();
    onBack();
  };

  const startOAuth = async () => {
    let endpoint: URL;
    try {
      endpoint = new URL(form.endpointUrl);
      if (endpoint.protocol !== "https:") throw new Error();
    } catch {
      setOAuth({ ...EMPTY_OAUTH, phase: "failed", message: "Enter a valid HTTPS MCP endpoint first." });
      return;
    }
    // Keep this before the first await so browsers treat the popup as a direct
    // consequence of the user's click instead of blocking it.
    cancelOAuth();
    const generation = oauthGenerationRef.current;
    const popup = window.open("about:blank", "bcontext-provider-oauth", "popup,width=560,height=760");
    if (popup) {
      try { popup.opener = null; } catch {}
      popup.document.title = "Connecting provider…";
      popupRef.current = popup;
    }
    setOAuth({ ...EMPTY_OAUTH, phase: "starting", message: "Discovering the provider authorization server…" });
    try {
      const response = await fetch("/api/capabilities/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          endpoint_url: endpoint.toString(),
          allowed_hosts: [endpoint.hostname],
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        attempt_id?: string;
        authorization_url?: string;
        authorization_host?: string;
        message?: string;
      };
      if (!response.ok || !body.attempt_id || !body.authorization_url) {
        throw new Error(body.message ?? `HTTP ${response.status}`);
      }
      if (generation !== oauthGenerationRef.current) {
        const query = new URLSearchParams({ workspace_id: workspaceId, attempt_id: body.attempt_id });
        void fetch(`/api/capabilities/oauth/status?${query}`, { method: "DELETE", keepalive: true }).catch(() => {});
        popup?.close();
        return;
      }
      const next: OAuthUiState = {
        phase: "waiting",
        attemptId: body.attempt_id,
        authorizationUrl: body.authorization_url,
        authorizationHost: body.authorization_host ?? new URL(body.authorization_url).hostname,
        message: popup ? "Complete authorization in the popup." : "Your browser blocked the popup. Open authorization below.",
      };
      setOAuth(next);
      if (popup && !popup.closed) popup.location.replace(body.authorization_url);
    } catch (cause) {
      popup?.close();
      popupRef.current = null;
      if (generation !== oauthGenerationRef.current) return;
      setOAuth({ ...EMPTY_OAUTH, phase: "failed", message: (cause as Error).message });
    }
  };

  useEffect(() => {
    if (oauth.phase !== "waiting" || !oauth.attemptId) return;
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      if (popupRef.current?.closed) {
        popupRef.current = null;
        setOAuth((state) => ({ ...state, message: "Authorization window closed. Reopen it below, or try again." }));
      }
      const query = new URLSearchParams({ workspace_id: workspaceId, attempt_id: oauth.attemptId });
      try {
        const response = await fetch(`/api/capabilities/oauth/status?${query}`, { cache: "no-store" });
        const body = (await response.json().catch(() => ({}))) as { status?: string; message?: string; error_code?: string };
        if (stopped) return;
        if (response.ok && (body.status === "authorized" || body.status === "connected")) {
          popupRef.current?.close();
          popupRef.current = null;
          const current = latestRef.current;
          const authorizedForm = {
            ...current.form,
            oauthAttemptId: oauth.attemptId,
            credentialMode: "replace" as const,
            credentialConfigured: true,
          };
          current.onChange(authorizedForm);
          setOAuth((state) => ({ ...state, phase: "discovering", message: "Authorized. Importing provider tools…" }));
          const discovered = await current.onDiscover(authorizedForm);
          if (mountedRef.current && latestRef.current.form.oauthAttemptId === oauth.attemptId) setOAuth((state) => ({
            ...state,
            phase: discovered ? "ready" : "failed",
            message: discovered ? "OAuth connected and tools imported." : "Authorization succeeded, but tool discovery failed.",
          }));
          return;
        }
        if (!response.ok || ["failed", "expired", "cancelled"].includes(body.status ?? "")) {
          const expired = body.status === "expired";
          popupRef.current?.close();
          popupRef.current = null;
          setOAuth((state) => ({ ...state, phase: expired ? "expired" : "failed", message: body.message ?? body.error_code ?? "Authorization failed." }));
          return;
        }
      } catch {
        // A transient polling failure is retried while the short-lived attempt remains active.
      } finally {
        inFlight = false;
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 500);
    const pollOnFocus = () => { if (!stopped && document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", pollOnFocus);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", pollOnFocus);
    };
  }, [oauth.attemptId, oauth.phase, workspaceId]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      oauthGenerationRef.current += 1;
      popupRef.current?.close();
      const attemptId = oauthRef.current.attemptId;
      if (attemptId) {
        const query = new URLSearchParams({ workspace_id: workspaceId, attempt_id: attemptId });
        void fetch(`/api/capabilities/oauth/status?${query}`, { method: "DELETE", keepalive: true }).catch(() => {});
      }
    };
  }, [workspaceId]);

  const staticAuth = form.authType === "bearer" || form.authType === "header";
  // Editing a provider whose token lives in the server vault: the field stays
  // empty and locked until the user explicitly chooses to replace it.
  const preservingCredential = form.credentialMode === "preserve" && form.credentialConfigured;
  const endpointValid = isValidHttpsProviderEndpoint(form.endpointUrl);
  const connectionValid = isProviderConnectionValid(form, authConfirmed);
  const valid = Boolean(form.title.trim() && form.provider.trim() && connectionValid && (isMcp ? form.tools.length > 0 : form.remoteTool.trim()));
  const authTypes: AuthType[] = isMcp ? ["none", "oauth", "bearer", "header"] : ["none", "bearer", "header"];

  useEffect(() => {
    if (
      form.type !== "mcp_server"
      || !authConfirmed
      || !connectionValid
      || saving
      || form.tools.length > 0
    ) return;
    const discoveryKey = connectionFingerprint(form);
    if (lastAutoDiscoveryRef.current === discoveryKey) return;
    const timer = setTimeout(() => {
      const latest = latestRef.current.form;
      if (connectionFingerprint(latest) !== discoveryKey) return;
      lastAutoDiscoveryRef.current = discoveryKey;
      void latestRef.current.onDiscover(latest);
    }, 700);
    return () => clearTimeout(timer);
  }, [authConfirmed, connectionValid, form, saving]);

  const heading = editing
    ? "Edit tool provider"
    : isMcp ? "Add MCP server" : "Add API / workflow tool";
  const subheading = editing
    ? "Update its connection or metadata. Material changes revoke existing grants for review."
    : isMcp
      ? "Paste its URL. Bcontext detects the provider, logo and tools for you."
      : "Register a POST endpoint agents can invoke as a single remote tool.";

  return <Modal.Backdrop
    isOpen
    onOpenChange={(next) => { if (!next) close(); }}
    isDismissable={!saving}
    isKeyboardDismissDisabled
  >
    <Modal.Container size="lg" scroll="inside">
      <Modal.Dialog aria-labelledby="provider-modal-title" className="sm:max-w-[640px]">
      <Modal.CloseTrigger />
      <Modal.Header className="gap-1">
        <Modal.Heading id="provider-modal-title">{heading}</Modal.Heading>
        <p className="text-[12.5px] leading-relaxed text-muted">{subheading}</p>
      </Modal.Header>

      <Modal.Body className="space-y-5 pb-2">
        {editing ? (
          <div>
            <Input
              autoFocus
              disabled={saving}
              label="Connection name"
              value={form.title}
              placeholder="Supabase Prod"
              onChange={(value) => patch({ title: value })}
            />
            <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--ink-3)]">Shown on the Tools grid. Rename freely — two connections to the same provider can be told apart (e.g. “Supabase Prod” and “Supabase E2E”). Renaming never revokes agent grants.</p>
          </div>
        ) : null}
        <div>
          <Input
            autoFocus={!editing}
            disabled={saving}
            label={isMcp ? "MCP server URL" : "Webhook URL"}
            value={form.endpointUrl}
            placeholder={isMcp ? "https://mcp.example.com/mcp" : "https://api.example.com/actions/run"}
            onChange={changeEndpoint}
          />
          {isMcp ? <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--ink-3)]">Name, provider, description, logo and available tools are filled in automatically.</p> : null}
          {endpointValid && form.provider ? <div className="mt-3 rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-3 py-2.5"><div className="flex items-center gap-2"><Server size={12} className="text-[var(--ink-3)]" /><span className="text-[11.5px] font-medium">{form.title}</span><span className="font-mono text-[9.5px] text-[var(--ink-mute)]">endpoint: {new URL(form.endpointUrl).hostname}</span></div>{declaredLabel(form.declaredMetadata, form.title) ? <p className="mt-1 pl-5 text-[9.5px] text-[var(--ink-mute)]">Server-declared label (unverified): {declaredLabel(form.declaredMetadata, form.title)}</p> : null}</div> : null}
        </div>

        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.05em] text-[var(--ink-mute)]">Authentication</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{authTypes.map((auth) => <Button key={auth} aria-pressed={authConfirmed && form.authType === auth} isDisabled={saving} onPress={() => selectAuth(auth)} variant="outline" className={`h-auto rounded-md border px-2 py-2.5 text-[11px] font-normal disabled:opacity-50 ${authConfirmed && form.authType === auth ? "border-[var(--ink)] bg-[var(--paper-2)]" : "border-[var(--line)]"}`}>{auth === "oauth" ? "OAuth" : auth === "none" ? "No auth" : auth === "bearer" ? "Bearer token" : "Custom header"}</Button>)}</div>
          {!authConfirmed ? <p className="mt-2 text-[10.5px] text-[var(--ink-3)]">Choose how this endpoint authenticates.</p> : null}
        </div>

        {form.authType === "oauth" && authConfirmed ? <div className="rounded-[10px] border border-[var(--line)] bg-[var(--paper-2)] p-3"><div className="flex items-start gap-3"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--paper)]"><LockKeyhole size={14} /></div><div className="min-w-0 flex-1"><p className="text-[12px] font-medium">Connect with OAuth</p><p className="mt-0.5 text-[10.5px] leading-relaxed text-[var(--ink-3)]">Bcontext opens the provider authorization page. Tokens and client credentials stay encrypted on the server.</p>{oauth.message ? <p role={oauth.phase === "failed" || oauth.phase === "expired" ? "alert" : "status"} aria-live="polite" className={`mt-2 text-[10.5px] ${oauth.phase === "failed" || oauth.phase === "expired" ? "text-red-500" : "text-[var(--ink-3)]"}`}>{oauth.message}</p> : null}{oauth.authorizationHost ? <p className="mt-1 font-mono text-[9.5px] text-[var(--ink-mute)]">Authorization: {oauth.authorizationHost}</p> : null}</div>{oauth.phase === "ready" || form.oauthAttemptId || (form.credentialMode === "preserve" && form.credentialConfigured) ? <div className="flex shrink-0 items-center gap-2"><span className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)]/30 bg-[var(--accent-2)] px-2 py-1 text-[9.5px] text-[var(--accent)]"><Check size={9} /> Connected</span>{form.credentialMode === "preserve" ? <Button isDisabled={!endpointValid || saving} onPress={() => { patch({ credentialMode: "replace", credentialConfigured: false, tools: [] }); void startOAuth(); }} variant="ghost" className="h-auto min-w-0 p-0 text-[10px] text-[var(--ink-3)] underline underline-offset-2">Reconnect</Button> : null}</div> : <Button isDisabled={!endpointValid || saving || oauth.phase === "starting" || oauth.phase === "waiting" || oauth.phase === "discovering"} onPress={() => void startOAuth()} className="h-auto shrink-0 gap-1.5 rounded-md bg-[var(--ink)] px-3 py-2 text-[10.5px] text-[var(--paper)] disabled:opacity-50">{oauth.phase === "starting" || oauth.phase === "discovering" ? <LoaderCircle size={11} className="animate-spin" /> : <ExternalLink size={11} />}{oauth.phase === "expired" || oauth.phase === "failed" ? "Try again" : "Connect"}</Button>}</div>{oauth.authorizationUrl && oauth.phase === "waiting" ? <a href={oauth.authorizationUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-[10.5px] underline underline-offset-2">Open authorization <ExternalLink size={10} /></a> : null}</div> : null}

        {staticAuth && authConfirmed ? <div className="grid grid-cols-2 gap-3">
          {form.authType === "header" ? <Input disabled={saving} label="Header name" value={form.authHeaderName} placeholder="X-API-Key" onChange={(value) => patch({ authHeaderName: value, tools: [], credentialMode: "replace", credentialConfigured: false })} /> : null}
          <Input
            disabled={saving || preservingCredential}
            type="password"
            autoComplete="off"
            className={form.authType === "header" ? "" : "col-span-2"}
            label={form.authType === "bearer" ? "Token" : "Header value"}
            value={form.secret}
            placeholder={preservingCredential ? "••••••••••••" : form.authType === "bearer" ? "Paste the bearer token" : "Paste the header value"}
            onChange={(value) => patch({ secret: value, tools: [], credentialMode: "replace", credentialConfigured: false })}
          />
          {preservingCredential
            ? <div className="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] leading-relaxed text-[var(--ink-3)]"><span className="inline-flex items-center gap-1"><LockKeyhole size={10} /> A credential is stored for this connection; it is never shown again.</span><Button isDisabled={saving} onPress={() => patch({ credentialMode: "replace", credentialConfigured: false, secret: "", tools: [] })} variant="ghost" className="h-auto min-w-0 p-0 text-[10.5px] text-[var(--ink)] underline underline-offset-2">Replace credential</Button></div>
            : <p className="col-span-2 text-[10.5px] leading-relaxed text-[var(--ink-3)]">Stored encrypted on the server and never shown again — not even to you. Bcontext sends it only to this endpoint.</p>}
        </div> : null}

        {isMcp ? <div className="rounded-[10px] border border-[var(--line)] bg-[var(--paper-2)] p-3"><div className="flex items-center gap-3"><div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${form.tools.length ? "border-[var(--accent)]/30 bg-[var(--accent-2)] text-[var(--accent)]" : "border-[var(--line)] bg-[var(--paper)]"}`}>{saving ? <LoaderCircle size={13} className="animate-spin" /> : form.tools.length ? <Check size={13} /> : <Server size={13} />}</div><div className="min-w-0"><div className="flex items-center gap-2 text-[12px] font-medium">{saving ? "Detecting provider…" : form.tools.length ? `${form.tools.length} tool${form.tools.length === 1 ? "" : "s"} ready` : "Automatic discovery"}{form.logoUrl ? <span title="Artwork resolved from the provider domain; not identity verification." className="rounded-full border border-[var(--line)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--ink-mute)]">provider logo · unverified</span> : null}</div><p className="mt-0.5 text-[10.5px] text-[var(--ink-3)]">{saving ? "Reading MCP metadata and importing its tool catalog." : form.tools.length ? `${form.title || "Provider"} is ready ${form.capabilityId ? "to update" : "to add to the gateway"}.` : !endpointValid ? "Paste a valid HTTPS endpoint to continue." : !authConfirmed ? "Choose an authentication type to continue." : form.authType === "oauth" && !form.oauthAttemptId && form.credentialMode !== "preserve" ? "Authorize the provider to import its tools." : error ? "Automatic discovery needs attention. You can retry it." : "Bcontext will detect it automatically."}</p></div>{connectionValid && !saving && form.credentialMode !== "preserve" ? <Button onPress={() => void onDiscover(form)} variant="outline" className="ml-auto h-auto shrink-0 rounded-md border-[var(--line)] bg-[var(--paper)] px-2.5 py-2 text-[10.5px] font-normal">{form.tools.length ? "Refresh" : "Try now"}</Button> : null}</div></div> : null}

        {!isMcp ? <Input disabled={saving} label="Remote tool name" value={form.remoteTool} placeholder="search_records" onChange={(value) => patch({ remoteTool: value })} /> : null}

        <details className="group rounded-[10px] border border-[var(--line)]">
          <summary className="flex cursor-pointer list-none items-center px-3 py-2.5 text-[11px] text-[var(--ink-3)] marker:hidden"><span>Advanced details</span><span className="ml-2 font-mono text-[9px] text-[var(--ink-mute)]">optional</span><span className="ml-auto transition-transform group-open:rotate-45"><Plus size={11} /></span></summary>
          <div className="space-y-4 border-t border-[var(--line)] p-3">
            <div className="grid grid-cols-2 gap-3"><Input disabled={saving} label="Display name" value={form.title} onChange={(value) => patch({ title: value })} /><Input disabled={saving} label="Provider" value={form.provider} onChange={(value) => patch({ provider: value })} /><Input disabled={saving} className="col-span-2" label="Description" value={form.description} onChange={(value) => patch({ description: value })} /></div>
            {isMcp && form.tools.length ? <div><p className="mb-2 font-mono text-[9.5px] uppercase tracking-[0.05em] text-[var(--ink-mute)]">Imported tools</p><div className="max-h-36 space-y-1.5 overflow-y-auto">{form.tools.map((tool) => <div key={tool.name} className="flex items-center gap-2"><Check size={10} className="text-[var(--accent)]"/><span className="font-mono text-[10.5px]">{tool.name}</span></div>)}</div></div> : null}
            {!isMcp ? <p className="flex items-center gap-1.5 text-[10.5px] text-[var(--ink-3)]"><Webhook size={11} /> Agents invoke this endpoint with a POST request. Retries are disabled by default.</p> : null}
          </div>
        </details>

        {error ? <p className="rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</p> : null}
      </Modal.Body>

      <Modal.Footer className="flex items-center gap-2">
        {onBack && !editing ? (
          <Button isDisabled={saving} onPress={back} variant="ghost" size="sm" className="gap-1.5"><ArrowLeft size={13} /> Back</Button>
        ) : null}
        <span className="ml-auto" />
        <Button isDisabled={saving} onPress={close} variant="outline" size="sm">Cancel</Button>
        <Button isDisabled={!valid || saving} onPress={onSave} size="sm" className="gap-1.5"><Check size={12} />{saving ? form.capabilityId ? "Saving…" : "Adding…" : form.capabilityId ? "Save changes" : "Add to gateway"}</Button>
      </Modal.Footer>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}

function Input({ label, value, onChange, className = "", placeholder, disabled = false, autoFocus = false, type = "text", autoComplete }: { label: string; value: string; onChange: (value: string) => void; className?: string; placeholder?: string; disabled?: boolean; autoFocus?: boolean; type?: "text" | "password"; autoComplete?: string }) {
  return <label className={`flex flex-col gap-1.5 text-[10.5px] text-[var(--ink-3)] ${className}`}>{label}<TextField aria-label={label} type={type} autoComplete={autoComplete} value={value} isDisabled={disabled} onChange={onChange}><HeroInput autoFocus={autoFocus} placeholder={placeholder} className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2.5 text-[12px] outline-none focus:border-[var(--ink-mute)] disabled:opacity-50" /></TextField></label>;
}
