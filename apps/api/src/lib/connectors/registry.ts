/**
 * Connector registry — lookup connectors by id at runtime.
 *
 * Connectors register themselves at module load by calling
 * `registerConnector`. Routes / runtime use `getConnector(id)`
 * to dispatch. Throws on unknown ids so a typo never silently no-ops.
 */
import type { Connector, ConnectorId } from "@bcontext-dev/contract/connectors/types";

const registry = new Map<ConnectorId, Connector>();

export function registerConnector(c: Connector): void {
  registry.set(c.id, c);
}

export function getConnector(id: string): Connector {
  const c = registry.get(id as ConnectorId);
  if (!c) {
    throw new Error(`unknown connector: ${id}`);
  }
  return c;
}

export function getConnectorOrNull(id: string): Connector | null {
  return registry.get(id as ConnectorId) ?? null;
}

export function listConnectors(): Connector[] {
  return Array.from(registry.values());
}

/** Test helper. Never call from app code. */
export function _resetRegistry(): void {
  registry.clear();
}
