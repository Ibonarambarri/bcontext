"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Description, Input, Label, TextField } from "@heroui/react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { orgAiKeysApi } from "@/lib/nexos/api";
import type { OrgAiKey, OrgAiKeyProvider } from "@bcontext-dev/contract/nexos";
import { Block, SectionHead, formatDay } from "./panel-ui";

/**
 * The organization's own model keys (bring your own key), for administrators.
 *
 * With a key here, the organization's Nexos run on its provider account and
 * stop drawing on the instance's own AI Gateway key. The secret goes in once and is
 * never shown again — the API keeps it in its vault and answers with the
 * provider and the last four characters, which is all this screen can show.
 * A field that could reveal a stored key would be a reason not to store one.
 *
 * Data: `GET/PUT/DELETE /api/org/ai-keys`. Removing a key confirms: the
 * Nexos fall back to the instance's key at once.
 */

const PROVIDERS: { id: OrgAiKeyProvider; name: string; hint: string; placeholder: string }[] = [
  { id: "anthropic", name: "Anthropic", hint: "A key from console.anthropic.com.", placeholder: "sk-ant-…" },
  { id: "openai", name: "OpenAI", hint: "A project key from platform.openai.com.", placeholder: "sk-…" },
  { id: "gateway", name: "Vercel AI Gateway", hint: "An AI Gateway key; it routes to whichever provider the Nexo's model needs.", placeholder: "vck_…" },
];

export function AiKeysSection({ orgSlug }: { orgSlug: string }): React.JSX.Element {
  const [keys, setKeys] = useState<OrgAiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys(await orgAiKeysApi.list(orgSlug));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [orgSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <SectionHead
        title="AI keys"
        hint="Run this organization's Nexos on your own model account. Without a key they use this instance's default AI key."
      />
      {error && !keys ? (
        <Alert role="alert" status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : (
        PROVIDERS.map((provider) => (
          <ProviderKey
            key={provider.id}
            orgSlug={orgSlug}
            provider={provider}
            stored={keys?.find((k) => k.provider === provider.id) ?? null}
            loading={keys === null}
            onChanged={load}
          />
        ))
      )}
    </div>
  );
}

function ProviderKey({
  orgSlug,
  provider,
  stored,
  loading,
  onChanged,
}: {
  orgSlug: string;
  provider: (typeof PROVIDERS)[number];
  stored: OrgAiKey | null;
  loading: boolean;
  onChanged: () => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const value = secret.trim();
    if (!value || pending) return;
    setPending(true);
    setError(null);
    try {
      await orgAiKeysApi.put(orgSlug, provider.id, value);
      // The secret leaves the page as soon as the API has it.
      setSecret("");
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Block
      title={provider.name}
      hint={
        loading
          ? undefined
          : stored
            ? `In use: ends in ${stored.last4}, added ${formatDay(stored.created_at)}.`
            : "Not set."
      }
      action={
        stored ? (
          <Button size="sm" variant="danger-soft" onPress={() => setConfirmRemove(true)}>
            Remove
          </Button>
        ) : undefined
      }
    >
      <form onSubmit={save} className="max-w-md space-y-3">
        <TextField value={secret} onChange={setSecret} isDisabled={pending || loading} type="password" fullWidth>
          <Label>{stored ? "Replace the key" : "Key"}</Label>
          <Input placeholder={provider.placeholder} autoComplete="off" spellCheck={false} className="mono" />
          <Description>{provider.hint} It is stored encrypted and never shown again.</Description>
        </TextField>
        {error ? (
          <Alert role="alert" status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        <Button type="submit" size="sm" isDisabled={!secret.trim() || pending} isPending={pending}>
          {stored ? "Replace" : "Save key"}
        </Button>
      </form>
      <ConfirmDialog
        open={confirmRemove}
        title={`Remove the ${provider.name} key?`}
        body="Nexos that used it go back to this instance's default AI key straight away."
        confirmLabel="Remove"
        tone="danger"
        busy={removing}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          setRemoving(true);
          try {
            await orgAiKeysApi.remove(orgSlug, provider.id);
            await onChanged();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setRemoving(false);
            setConfirmRemove(false);
          }
        }}
      />
    </Block>
  );
}
