import { describe, expect, it } from "vitest";
import "./bootstrap";
import { NANGO_ADAPTERS } from "./nango/adapters";
import {
  getConnector,
  getConnectorOrNull,
  listConnectors,
} from "./registry";

describe("connector registry", () => {
  it("registers the native connectors and the Nango-backed ones via bootstrap import", () => {
    const ids = listConnectors()
      .map((c) => c.id)
      .sort();
    const nango = NANGO_ADAPTERS.map((a) => a.id);
    expect(ids).toEqual([...nango, "github", "linear", "notion", "slack"].sort());
    expect(nango).toEqual([...nango].sort());
  });

  it("getConnector returns the connector by id", () => {
    expect(getConnector("github").id).toBe("github");
    expect(getConnector("slack").id).toBe("slack");
    expect(getConnector("linear").id).toBe("linear");
    expect(getConnector("notion").id).toBe("notion");
  });

  it("getConnector throws on unknown id", () => {
    expect(() => getConnector("twitter")).toThrow(/unknown connector/);
  });

  it("getConnectorOrNull returns null on unknown id", () => {
    expect(getConnectorOrNull("twitter")).toBeNull();
  });
});
