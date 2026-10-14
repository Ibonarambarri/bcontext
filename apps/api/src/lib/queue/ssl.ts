/**
 * TLS for a Postgres connection string, decided in one place.
 *
 * Two copies of `connectionString.includes("localhost") ? undefined : {...}`
 * agreed with each other and were both wrong: `supabase status` hands out
 * `127.0.0.1`, so the first local worker boot demanded TLS from a server that
 * has none and died with "The server does not support SSL connections".
 *
 * Loopback in any spelling means plain TCP. Anything else — the hosted pooler
 * above all — gets TLS with `rejectUnauthorized: false`, because Supabase
 * presents a chain Node ships no root for; the connection is still encrypted.
 * `DATABASE_SSL=disable|require` overrides the guess when the guess is wrong.
 */
export function sslFor(
  connectionString: string,
): { rejectUnauthorized: boolean } | undefined {
  const forced = process.env.DATABASE_SSL;
  if (forced === "disable") return undefined;
  if (forced === "require") return { rejectUnauthorized: false };

  let host = "";
  try {
    host = new URL(connectionString).hostname;
  } catch {
    // Not a URL-shaped string; fall through to the substring check below.
  }
  const loopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    (host === "" && /localhost|127\.0\.0\.1/.test(connectionString));
  return loopback ? undefined : { rejectUnauthorized: false };
}
