/**
 * The browser half of the error pipeline: two global listeners, a hard budget,
 * and a beacon to `/api/client-errors`.
 *
 * Browser errors are the ones nobody ever hears about. A server exception
 * shows up in a log and eventually in a support ticket; a `TypeError` in a
 * render only ever reaches the person whose screen went blank, who reloads
 * and moves on. That asymmetry is why this exists at all.
 *
 * It is also why the budget is the first design decision rather than the last.
 * A page in a render loop can throw the same error thousands of times a
 * second, and a reporter without a ceiling turns one user's broken tab into a
 * denial of service against the collector — and the table into noise, which
 * costs more than the missing events ever would. So:
 *
 *   - `MAX_PER_SESSION` events total, ever, per page load. The first ten say
 *     everything the eleventh would.
 *   - Repeats of an error already sent are dropped, keyed by message + the
 *     first stack frame. One problem is one row here too.
 *
 * Transport is `sendBeacon` where available: it survives the page being closed
 * — which is exactly when an error tends to arrive — and it cannot be made to
 * block navigation. `fetch(..., { keepalive: true })` is the fallback, and a
 * failure of either is silently ignored, because a reporter that reports its
 * own failure is a loop.
 *
 * No Next imports: this is plain DOM code so it can be mounted from anywhere.
 */

const ENDPOINT = "/api/client-errors";
const MAX_PER_SESSION = 10;

let installed = false;
let sent = 0;
const seen = new Set<string>();

interface ClientReport {
  operation: string;
  message: string;
  error_type?: string;
  stack?: string;
  url?: string;
  path?: string;
  viewport?: string;
}

function describe(value: unknown): { message: string; error_type: string; stack?: string } {
  if (value instanceof Error) {
    return {
      message: value.message || String(value),
      error_type: value.name || "Error",
      stack: value.stack,
    };
  }
  if (typeof value === "object" && value !== null) {
    let message: string;
    try {
      message = JSON.stringify(value);
    } catch {
      message = String(value);
    }
    return { message, error_type: "Object" };
  }
  return { message: String(value), error_type: typeof value };
}

/** Message plus the first stack frame: enough to tell two bugs apart, stable
 *  enough that the same bug thrown twice looks the same. */
function dedupeKey(message: string, stack?: string): string {
  const frame = stack?.split("\n")[1]?.trim() ?? "";
  return `${message}::${frame}`;
}

function post(report: ClientReport): void {
  try {
    const body = JSON.stringify(report);
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      // A Blob with an explicit type: without it the browser sends
      // `text/plain` and the route's JSON.parse still works, but the intent is
      // worth being explicit about.
      const ok = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      if (ok) return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // See the module note: never a second failure.
  }
}

/**
 * Report one error. Exported so a React error boundary can hand over what it
 * caught — the boundary already stopped the error from reaching `window`, so
 * without this call those are precisely the errors that would go unrecorded.
 */
export function reportClientError(value: unknown, operation?: string): void {
  try {
    if (typeof window === "undefined") return;
    if (sent >= MAX_PER_SESSION) return;
    const described = describe(value);
    if (!described.message) return;
    const key = dedupeKey(described.message, described.stack);
    if (seen.has(key)) return;
    seen.add(key);
    sent += 1;

    post({
      operation: operation ?? `browser:${window.location.pathname}`,
      message: described.message,
      error_type: described.error_type,
      stack: described.stack,
      url: window.location.href,
      path: window.location.pathname,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    });
  } catch {
    // Ditto.
  }
}

/**
 * Attach the two global listeners. Idempotent: React strict mode mounts the
 * component that calls this twice in development, and a second set of
 * listeners would double every report.
 */
export function installClientErrorReporter(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    // `event.error` is the thrown value when there is one; a cross-origin
    // script error has only the sanitised message, which is still worth a row
    // (it says "a third-party script is failing" and nothing more, which is
    // itself the finding).
    reportClientError(event.error ?? event.message);
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    reportClientError(event.reason, `browser:${window.location.pathname}#rejection`);
  });
}
