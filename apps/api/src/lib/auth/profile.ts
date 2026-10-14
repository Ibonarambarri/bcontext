/**
 * A person's name, as Supabase Auth stores it.
 *
 * There is no `profiles` table and this is why: the two strings a person
 * types into their profile already have a home in `auth.users.user_metadata`,
 * the auth server keeps them, and every surface that resolves a user id
 * (member rosters, org admin, activity) already goes through the admin API to
 * read the email. A table would add a migration, a trigger, and a second
 * source of truth for `first_name`.
 *
 * `full_name` and `name` are written alongside the two halves because they
 * are the keys other tools expect from Supabase metadata (email templates,
 * the Supabase dashboard); nothing here reads them back — `first_name` and
 * `last_name` are authoritative.
 */
import {
  joinName,
  normalizeNamePart,
  type MeUser,
  type PersonName,
} from "@bcontext-dev/contract/me";

/** The shape we care about out of a Supabase auth user. */
export interface AuthUserLike {
  id?: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  app_metadata?: Record<string, unknown> | null;
  identities?: Array<{ provider?: string | null }> | null;
}

/** The name halves carried in a user's metadata, normalized. */
export function namesFromUser(user: AuthUserLike | null | undefined): PersonName {
  const meta = user?.user_metadata ?? {};
  return {
    first_name: normalizeNamePart(meta.first_name),
    last_name: normalizeNamePart(meta.last_name),
  };
}

/** The `MeUser` an API response carries for a Supabase auth user. */
export function meUserFrom(
  userId: string,
  user: AuthUserLike | null | undefined,
): MeUser {
  const names = namesFromUser(user);
  return {
    id: userId,
    email: user?.email ?? null,
    first_name: names.first_name,
    last_name: names.last_name,
    full_name: joinName(names),
  };
}

/**
 * The metadata patch that stores a name. Merged into the existing metadata
 * by the caller — `updateUserById` replaces `user_metadata` wholesale, so a
 * partial patch sent on its own would drop `signup_complete` with it.
 */
export function nameMetadata(name: PersonName): Record<string, unknown> {
  const first = normalizeNamePart(name.first_name);
  const last = normalizeNamePart(name.last_name);
  const full = joinName({ first_name: first, last_name: last });
  return {
    first_name: first,
    last_name: last,
    full_name: full,
    // Supabase's own conventional key, and what its email templates read.
    name: full,
  };
}

/**
 * Does this account sign in with a password we hold?
 *
 * Supabase reports every identity a user has; `email` is the password one.
 * A user with only an OAuth identity has no current password to verify a
 * change against, so the profile offers them the reset link instead.
 */
export function hasPasswordIdentity(user: AuthUserLike | null | undefined): boolean {
  const identities = user?.identities;
  if (!Array.isArray(identities) || identities.length === 0) {
    // Older rows (and the admin-created accounts of the private beta) may
    // carry no identity list at all; they were created with a password.
    return Boolean(user?.email);
  }
  return identities.some((i) => i?.provider === "email");
}
