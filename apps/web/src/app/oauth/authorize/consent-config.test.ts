import { describe, expect, it } from "vitest";
import { ROLE_SCOPES } from "@bcontext-dev/contract/agents/connections";
import { CONSENT_ROLES, initialConsentScopes } from "./consent-config";

describe("OAuth consent configuration", () => {
  it("keeps the consent role presets in lockstep with the canonical presets", () => {
    for (const role of CONSENT_ROLES) {
      if (role.value === "custom") {
        expect(role.scopes).toEqual([]);
      } else {
        expect(role.scopes).toEqual(ROLE_SCOPES[role.value]);
      }
    }
  });

  it("never grants a preset scope the client did not request", () => {
    expect(initialConsentScopes("operator", ["nodes:read", "chat:run"])).toEqual([
      "nodes:read",
      "chat:run",
    ]);
    expect(initialConsentScopes("collaborator", ["nodes:read"])).toEqual(["nodes:read"]);
  });

  it("starts the custom role with an empty selection", () => {
    expect(initialConsentScopes("custom", ["nodes:read", "nodes:write"])).toEqual([]);
  });

  it("defaults collaborator to exactly the requested read/write pairs", () => {
    expect(
      initialConsentScopes("collaborator", [
        "nodes:read",
        "nodes:write",
        "agents:read",
        "agents:write",
        "chat:run",
      ]),
    ).toEqual(["nodes:read", "nodes:write", "agents:read", "agents:write"]);
  });
});
