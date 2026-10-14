/**
 * GET /api/me — who the session belongs to, what they are called, and
 * whether that person is a platform admin. The admin allowlist itself stays
 * on the API side (`@/lib/admin/access`); the web only ever sees the answer.
 *
 * The name lives in Supabase Auth's `user_metadata` (`first_name` /
 * `last_name`) rather than a table of our own: there is no `profiles` table
 * and one row per person, joined nowhere, would be a migration and a
 * synchronisation problem for two strings the auth server already stores.
 */

/** The two halves of a person's name, either of which may be missing. */
export interface PersonName {
  first_name: string | null;
  last_name: string | null;
}

export interface MeUser extends PersonName {
  id: string;
  email: string | null;
  /** Both halves joined, or null when the person has given neither. */
  full_name: string | null;
}

export interface Me {
  user: MeUser;
  is_admin: boolean;
  /**
   * The account signs in with an email + password, so it can change that
   * password here. False for an identity we do not hold the password for
   * (OAuth), where the form would have nothing to verify against.
   */
  has_password: boolean;
  /**
   * Whether this person may create an organization (`POST /api/organizations`):
   * always on an `ORG_CREATION=open` instance, only for instance admins on an
   * `admin` one.
   */
  can_create_organization: boolean;
}

/**
 * `POST /api/signup` — an account on an instance that allows self-service
 * (`ORG_CREATION=open`; `403 signup_closed` otherwise, where accounts arrive
 * by invitation). Anonymous by definition.
 */
export interface SignupBody {
  email: string;
  password: string;
  first_name: string;
  last_name?: string;
}

/**
 * `201` from `POST /api/signup`. `email_sent`: the account waits for the
 * link in the confirmation email. `not_required`: the instance has no email
 * transport configured, so the account was confirmed on creation and the
 * person can sign in straight away. When the transport fails the call is
 * `503 confirm_email_failed` and no account is left behind: retrying is safe.
 */
export interface SignupResult {
  email: string;
  confirmation: "email_sent" | "not_required";
}

/** PATCH /api/me — the parts of a profile a person edits themselves. */
export interface MeUpdate {
  first_name?: string;
  last_name?: string;
}

/** POST /api/me/password — a change, not a reset: the old one is proof. */
export interface PasswordChange {
  current_password: string;
  new_password: string;
}

/** Shortest password the API accepts, matching Supabase Auth's own floor. */
export const MIN_PASSWORD_LENGTH = 8;

/** How long each half of a name may be. */
export const MAX_NAME_LENGTH = 60;

/** Trim, collapse inner whitespace, and treat an empty string as absent. */
export function normalizeNamePart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
  return clean.length > 0 ? clean : null;
}

/** First + last, or whichever half exists; null when neither does. */
export function joinName(name: Partial<PersonName> | null | undefined): string | null {
  const first = normalizeNamePart(name?.first_name);
  const last = normalizeNamePart(name?.last_name);
  const joined = [first, last].filter(Boolean).join(" ");
  return joined.length > 0 ? joined : null;
}

/**
 * What to call someone on screen: their name if they have given one, else
 * the local part of their email — an address in a sidebar reads like a
 * database row, and it is the one thing every account has. "You" is the last
 * resort, for a session with neither.
 */
export function displayName(
  user: (Partial<MeUser> & { email?: string | null }) | null | undefined,
): string {
  const named = user?.full_name?.trim() || joinName(user ?? null);
  if (named) return named;
  const email = user?.email?.trim();
  if (email) {
    const local = email.split("@")[0] ?? email;
    return local || email;
  }
  return "You";
}

/**
 * One or two letters for an avatar: the initials of a real name, otherwise
 * the first character of whatever `displayName` settled on.
 */
export function initialsFor(
  user: (Partial<MeUser> & { email?: string | null }) | null | undefined,
): string {
  const first = normalizeNamePart(user?.first_name);
  const last = normalizeNamePart(user?.last_name);
  if (first && last) return (first[0]! + last[0]!).toUpperCase();
  const label = displayName(user);
  return label.slice(0, 1).toUpperCase() || "Y";
}
