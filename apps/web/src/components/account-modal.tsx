"use client";

import { useEffect, useState } from "react";
import { KeyRound, Loader2, UserRound, X } from "lucide-react";
import {
  Alert,
  Button,
  Description,
  Input,
  Label,
  Modal,
  Separator,
  TextField,
} from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import {
  MIN_PASSWORD_LENGTH,
  displayName,
  type Me,
} from "@bcontext-dev/contract/me";
import { publishMe, useMe } from "@/hooks/use-me";
import { PersonAvatar } from "./person-avatar";

/**
 * Your account: the name people see, the address you sign in with, and the
 * password behind it. Opened from the user menu (`user-menu.tsx`); reads
 * `useMe()` and writes through `PATCH /api/me` and `POST /api/me/password`,
 * publishing the fresh `Me` so every avatar and roster updates at once.
 *
 * The name is the account's own `first_name` / `last_name` — it travels with
 * the account, so the roster of an organization can call somebody by name
 * rather than by email — which is why this dialog can afford to be the one
 * place a person is edited.
 *
 * Two sections rather than one long form, because they fail differently: a
 * rename is a save, and a password change is a verification. Mixing them puts
 * "that is not your current password" underneath a field about surnames.
 */

type Section = "profile" | "security";

export function AccountModal({ onClose }: { onClose: () => void }) {
  const { me, loading } = useMe();
  const [section, setSection] = useState<Section>("profile");

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className="backdrop-blur-[6px]"
      style={{ background: "var(--ov-backdrop, rgba(0,0,0,0.55))" }}
    >
      <Modal.Container placement="center" className="p-4">
        <Modal.Dialog
          aria-label="Your account"
          className="relative flex max-h-[calc(100svh-48px)] w-full max-w-[640px] flex-col overflow-hidden rounded-[16px] border border-[var(--line)] bg-[var(--paper)] shadow-[0_30px_90px_-30px_rgba(0,0,0,0.55)]"
        >
          <Modal.CloseTrigger
            aria-label="Close (Esc)"
            className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-3)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
          >
            <X size={14} />
          </Modal.CloseTrigger>

          <header className="flex items-center gap-3.5 border-b border-[var(--line)] px-6 py-5">
            <PersonAvatar user={me?.user} size={48} animate="always" />
            <div className="min-w-0">
              <h2 className="truncate text-[17px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
                {loading ? "Your account" : displayName(me?.user)}
              </h2>
              {me?.user.email ? (
                <div className="truncate text-[12px] text-muted">{me.user.email}</div>
              ) : null}
            </div>
          </header>

          <nav
            aria-label="Account sections"
            className="flex shrink-0 gap-1 border-b border-[var(--line)] bg-[var(--paper-2)] px-4 py-2"
          >
            <SectionTab
              active={section === "profile"}
              onClick={() => setSection("profile")}
              icon={<UserRound size={13} />}
            >
              Profile
            </SectionTab>
            <SectionTab
              active={section === "security"}
              onClick={() => setSection("security")}
              icon={<KeyRound size={13} />}
            >
              Security
            </SectionTab>
          </nav>

          <div className="scroll min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {section === "profile" ? (
              <ProfileSection me={me} loading={loading} />
            ) : (
              <SecuritySection me={me} />
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-[var(--line)] px-6 py-3.5">
            <span className="text-[11.5px] text-muted">
              Signed in{me?.user.email ? ` as ${me.user.email}` : ""}.
            </span>
            <form action="/auth/signout" method="post">
              <Button type="submit" size="sm" variant="outline">
                Sign out
              </Button>
            </form>
          </footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function SectionTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-[12.5px]",
        active
          ? "bg-[var(--paper)] text-[var(--ink)]"
          : "text-[var(--ink-2)] hover:bg-[var(--paper)] hover:text-[var(--ink)]",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/* ─── Profile ─────────────────────────────────────────────────────────── */

function ProfileSection({ me, loading }: { me: Me | null; loading: boolean }) {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The fields are seeded from the account, not bound to it: a half-typed
  // surname must survive the re-render that a save of the other half causes.
  useEffect(() => {
    if (!me) return;
    setFirst(me.user.first_name ?? "");
    setLast(me.user.last_name ?? "");
  }, [me]);

  const dirty =
    me != null &&
    (first.trim() !== (me.user.first_name ?? "") ||
      last.trim() !== (me.user.last_name ?? ""));

  async function save() {
    if (!dirty || pending) return;
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ first_name: first.trim(), last_name: last.trim() }),
      });
      if (!res.ok) {
        setError(await apiMessage(res, "Couldn't save your name."));
        return;
      }
      publishMe((await res.json()) as Me);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div>
        <h3 className="text-[14px] font-semibold text-foreground">Your name</h3>
        <p className="mt-0.5 text-[12px] text-muted">
          What colleagues and agents see instead of your email address —
          in rosters, on activity, and everywhere this product says who did
          something.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          value={first}
          onChange={setFirst}
          isDisabled={loading || pending}
          maxLength={60}
          autoComplete="given-name"
          fullWidth
        >
          <Label>First name</Label>
          <Input placeholder="Ana" />
        </TextField>
        <TextField
          value={last}
          onChange={setLast}
          isDisabled={loading || pending}
          maxLength={60}
          autoComplete="family-name"
          fullWidth
        >
          <Label>Last name</Label>
          <Input placeholder="Ruiz" />
        </TextField>
      </div>

      <TextField value={me?.user.email ?? ""} isReadOnly isDisabled fullWidth>
        <Label>Email</Label>
        <Input />
        <Description>
          The address you sign in with. Changing it is not something you can do
          here yet — ask us and we&apos;ll move it.
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
        <Button type="submit" isDisabled={!dirty || pending} isPending={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        {saved ? <span className="text-[12px] text-muted">Saved.</span> : null}
      </div>
    </form>
  );
}

/* ─── Security ────────────────────────────────────────────────────────── */

function SecuritySection({ me }: { me: Me | null }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    current.length > 0 &&
    next.length >= MIN_PASSWORD_LENGTH &&
    confirm === next &&
    !pending;

  async function submit() {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    setDone(false);
    try {
      const res = await fetch("/api/me/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      if (!res.ok) {
        setError(await apiMessage(res, "Couldn't change your password."));
        return;
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setPending(false);
    }
  }

  if (me && !me.has_password) {
    return (
      <div className="space-y-3">
        <h3 className="text-[14px] font-semibold text-foreground">Password</h3>
        <p className="text-[12px] text-muted">
          This account signs in without a password, so there is none to change
          here.
        </p>
      </div>
    );
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <h3 className="text-[14px] font-semibold text-foreground">
          Change your password
        </h3>
        <p className="mt-0.5 text-[12px] text-muted">
          Your current password is what proves it is you — a session someone
          else left open cannot change it.
        </p>
      </div>

      <TextField
        value={current}
        onChange={setCurrent}
        type="password"
        autoComplete="current-password"
        isDisabled={pending}
        fullWidth
      >
        <Label>Current password</Label>
        <Input placeholder="••••••••" />
      </TextField>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          value={next}
          onChange={setNext}
          type="password"
          autoComplete="new-password"
          isDisabled={pending}
          fullWidth
        >
          <Label>New password</Label>
          <Input placeholder="••••••••" />
          <Description>At least {MIN_PASSWORD_LENGTH} characters.</Description>
        </TextField>
        <TextField
          value={confirm}
          onChange={setConfirm}
          type="password"
          autoComplete="new-password"
          isDisabled={pending}
          isInvalid={confirm.length > 0 && confirm !== next}
          fullWidth
        >
          <Label>Confirm new password</Label>
          <Input placeholder="••••••••" />
          {confirm.length > 0 && confirm !== next ? (
            <Description>They don&apos;t match yet.</Description>
          ) : null}
        </TextField>
      </div>

      {error ? (
        <Alert role="alert" status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {done ? (
        <Alert role="status" status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              Password changed. You stay signed in here; anywhere else will ask
              for the new one.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" isDisabled={!canSubmit} isPending={pending}>
          {pending ? (
            <>
              <Loader2 size={13} className="animate-spin" /> Changing…
            </>
          ) : (
            "Change password"
          )}
        </Button>
      </div>

      <Separator className="my-1" />

      <p className="text-[11.5px] text-muted">
        Forgotten it instead?{" "}
        <a href="/forgot" className="underline">
          Send yourself a reset link
        </a>
        .
      </p>
    </form>
  );
}

/**
 * The API answers failures with `{ message }` (and older routes `{ error }`).
 * Its refusals here — a wrong password, a name too long — are written for the
 * person reading them, so they are shown verbatim.
 */
async function apiMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as
    | { message?: unknown; error?: unknown }
    | null;
  if (typeof body?.message === "string") return body.message;
  if (typeof body?.error === "string") return body.error;
  return fallback;
}
