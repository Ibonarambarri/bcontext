/**
 * Opens the self-hosted Nango Connect UI for a session the API created.
 *
 * Two hosts, read at runtime (@/lib/public-env): `NANGO_PUBLIC_HOST` is the
 * Nango API (`apiURL`), `NANGO_CONNECT_URL` is the Connect UI SPA
 * (`baseURL`) — the self-hosted image serves it on its own listener, so it
 * is a separate origin. Both are optional: an instance without Nango leaves
 * them unset, and connecting a Nango-backed integration then fails with a
 * message that names the variables instead of reaching someone else's host.
 * Resolves when the person connected an account, rejects on error or when
 * they closed the UI without finishing.
 */
import { publicEnv } from "@/lib/public-env";

/** `sessionToken` comes from `POST /api/connectors/:id/install` (`connect.session_token`). */
export async function openNangoConnect(sessionToken: string): Promise<{ connectionId: string; providerConfigKey: string }> {
  const { nangoHost: NANGO_HOST, nangoConnectUrl: NANGO_CONNECT_URL } = publicEnv();
  if (!NANGO_HOST || !NANGO_CONNECT_URL) {
    throw new Error(
      "Nango is not configured on this instance (NANGO_PUBLIC_HOST, NANGO_CONNECT_URL).",
    );
  }
  const { default: Nango } = await import("@nangohq/frontend");
  const nango = new Nango({ host: NANGO_HOST, connectSessionToken: sessionToken });
  return new Promise((resolve, reject) => {
    let settled = false;
    const ui = nango.openConnectUI({
      sessionToken,
      baseURL: NANGO_CONNECT_URL,
      apiURL: NANGO_HOST,
      detectClosedAuthWindow: true,
      onEvent: (event) => {
        if (event.type === "connect") {
          settled = true;
          resolve({ connectionId: event.payload.connectionId, providerConfigKey: event.payload.providerConfigKey });
          ui.close();
        } else if (event.type === "close") {
          if (!settled) reject(new Error("closed"));
        }
      },
    });
  });
}
