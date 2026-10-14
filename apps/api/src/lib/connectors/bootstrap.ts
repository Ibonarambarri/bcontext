/**
 * Connector bootstrap. Routes that dispatch through the registry import
 * this module for its side-effect (`registerConnector` calls). Keeping
 * this in one place avoids accidental missed registrations and makes the
 * set of available connectors discoverable.
 *
 * Native connectors register themselves at import; Nango-backed ones are
 * built from their adapters (src/lib/connectors/nango/adapters/<id>.ts, listed in adapters/index.ts) — one
 * generic connector per adapter.
 */
import "./github";
import "./slack";
import "./linear";
import "./notion";
import { registerNangoConnectors } from "./nango";
import { NANGO_ADAPTERS } from "./nango/adapters";

registerNangoConnectors(NANGO_ADAPTERS);
