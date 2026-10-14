"use client";

import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Description,
  Input,
  Label,
  TextField,
} from "@heroui/react";
import type { OrgAdminDetail } from "@bcontext-dev/contract/organizations";
import { Block, SectionHead, apiMessage, formatDay } from "./panel-ui";

/**
 * The organization's identity — which, in this product, is one editable
 * thing.
 *
 * The section it replaces tried to look like a settings page and had to
 * invent content to do it: a second field showing the address, which is not a
 * setting because nothing on this screen can change it, and a row of counters
 * that the overview already leads with. Worse, printing the address here put
 * an internal identifier on screen next to a text box, which reads as an
 * invitation to edit it. Both are gone. What is left is the name, and the
 * name is genuinely worth a screen: it is what every person and every agent
 * in the company sees at the top of the product.
 *
 * The save stays disabled until the field differs from what was loaded,
 * because the honest state of a form nobody has touched is "nothing to do" —
 * an always-live button teaches people to press it to find out. Failures are
 * shown in the API's own words: its refusals are written for the person
 * reading them, and a message re-guessed here would be less specific than the
 * one it replaced.
 *
 * The closing paragraph is the part that is easy to get wrong. An
 * administrator who cannot delete or transfer the organization deserves to
 * know that in a sentence, not to discover it by pressing a greyed-out
 * "Delete organization" in a red box — a disabled destructive button promises
 * that the power exists and is being withheld, when in truth the act simply
 * lives with us today. So it is said once, in prose, and there is no danger
 * zone to look for.
 */
export function GeneralSection({
  detail,
  onChanged,
}: {
  detail: OrgAdminDetail;
  onChanged: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(detail.name);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const dirty = trimmed !== detail.name;

  // The confirmation is a note, not a state to be dismissed: it says the
  // write landed and then gets out of the way.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!dirty || pending) return;
    if (!trimmed) {
      setError("The organization needs a name.");
      return;
    }
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(
        `/api/organizations/${encodeURIComponent(detail.slug)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        },
      );
      if (!res.ok) {
        setError(await apiMessage(res, "Couldn't rename the organization."));
        return;
      }
      setSaved(true);
      // The dialog re-reads everything after a write, so the rail and the
      // other sections cannot keep showing the old name.
      onChanged();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <SectionHead
        title="General"
        hint="What this organization is called, everywhere it appears."
      />

      <Block title="Name">
        <form onSubmit={save} className="max-w-md space-y-4">
          <TextField
            value={name}
            onChange={setName}
            isDisabled={pending}
            maxLength={80}
            autoComplete="organization"
            fullWidth
          >
            <Label>Organization name</Label>
            <Input autoFocus placeholder="Acme Inc." />
            <Description>
              Shown to everyone in the company and to every agent connected to
              it. Changing it changes nothing else.
            </Description>
          </TextField>

          {error ? (
            <Alert role="alert" status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{error}</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              isDisabled={!dirty || pending}
              isPending={pending}
            >
              {pending ? "Saving…" : "Save changes"}
            </Button>
            {saved ? (
              <span className="text-[12.5px] text-muted">Saved.</span>
            ) : null}
          </div>
        </form>
      </Block>

      <Block title="What lives with us">
        <p className="max-w-xl text-[12.5px] leading-[1.6] text-muted">
          This organization has been here since{" "}
          {formatDay(detail.created_at)}, and its name is the only part of it
          you can change from here: organizations are created, handed to a
          different owner and removed by us today, so there is no button for
          any of that on this screen. Ask us and we will do it.
        </p>
      </Block>
    </div>
  );
}
