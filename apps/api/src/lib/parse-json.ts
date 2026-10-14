/**
 * Bounded JSON body reader for the REST handlers (`Request → Response`, no
 * framework). Routes call `readJsonBody` before any zod validation so an
 * oversized or malformed body is rejected with a ready-made 413/400 instead
 * of reaching the parser. The 64 KB default fits every body the API accepts
 * today; `maxBytes` is the per-call override.
 */
const DEFAULT_MAX_BYTES = 64_000;

export interface ParseSuccess<T> {
  ok: true;
  data: T;
}

export interface ParseFailure {
  ok: false;
  response: Response;
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/**
 * Reads a request body as text with a size cap and parses it as JSON.
 *
 * - Rejects with HTTP 413 when the body (or declared `Content-Length`) exceeds
 *   `maxBytes` (default 64 KB).
 * - Returns HTTP 400 when the body is not valid JSON.
 *
 * Callers receive either `{ ok: true, data }` or `{ ok: false, response }`
 * — the precomputed response can be returned directly from the route.
 */
export async function readJsonBody<T = unknown>(
  req: Request,
  opts: { maxBytes?: number } = {},
): Promise<ParseResult<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const declared = req.headers.get("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      return {
        ok: false,
        response: Response.json(
          { error: `request body exceeds ${maxBytes} bytes` },
          { status: 413 },
        ),
      };
    }
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return {
      ok: false,
      response: Response.json(
        { error: "could not read request body" },
        { status: 400 },
      ),
    };
  }

  if (raw.length > maxBytes) {
    return {
      ok: false,
      response: Response.json(
        { error: `request body exceeds ${maxBytes} bytes` },
        { status: 413 },
      ),
    };
  }

  try {
    const data = JSON.parse(raw) as T;
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      response: Response.json(
        { error: "invalid JSON body" },
        { status: 400 },
      ),
    };
  }
}
