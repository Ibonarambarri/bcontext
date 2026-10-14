import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TYPES,
  credentialEnvName,
  credentialRef,
  credentialSlotViews,
  credentialTypeDef,
  emptyCredential,
  missingCredentialSlots,
  parseCredentialRef,
  readCredential,
  redactCredentialData,
  writeCredential,
  REDACTED_VALUE,
} from "./credentials.js";

describe("readCredential", () => {
  it("reads a pre-schema node as a custom credential with its fields intact", () => {
    const credential = readCredential({
      fields: [
        { name: "Anon key", value: "eyJ.anon", secret: true },
        { name: "Project ref", value: "abc", secret: false },
      ],
    });
    expect(credential.type).toBe("custom");
    expect(credential.environment).toBeNull();
    expect(credential.fields).toHaveLength(2);
    expect(credential.fields[0]).toEqual({ key: null, name: "Anon key", value: "eyJ.anon", secret: true });
  });

  it("round-trips through writeCredential", () => {
    const credential = readCredential(
      writeCredential({
        ...emptyCredential("api_key", "prod"),
        service: "Stripe",
        fields: [{ key: "api_key", name: "API key", value: "sk_live_x", secret: true }],
      }),
    );
    expect(credential.type).toBe("api_key");
    expect(credential.environment).toBe("prod");
    expect(credential.service).toBe("Stripe");
    expect(credential.fields[0]?.key).toBe("api_key");
  });

  it("falls back to custom for an unknown type or environment", () => {
    const credential = readCredential({ credential: { type: "quantum", environment: "moon" }, fields: [] });
    expect(credential.type).toBe("custom");
    expect(credential.environment).toBeNull();
    expect(credentialTypeDef("quantum").id).toBe("custom");
  });
});

describe("credentialSlotViews", () => {
  it("merges stored values into the type's slots and keeps orphans as extra", () => {
    const credential = readCredential({
      credential: { type: "api_key_pair" },
      fields: [
        { key: "secret_key", name: "Secret key", value: "sk_1", secret: true },
        { name: "Account owner", value: "ana", secret: false },
      ],
    });
    const { slots, extra } = credentialSlotViews(credential);
    expect(slots.map((slot) => slot.key)).toEqual(["public_key", "secret_key", "base_url"]);
    expect(slots.find((slot) => slot.key === "secret_key")?.value).toBe("sk_1");
    expect(slots.find((slot) => slot.key === "public_key")?.index).toBe(-1);
    expect(extra.map((field) => field.name)).toEqual(["Account owner"]);
  });

  it("claims a keyless legacy field by its label, so retyping does not duplicate it", () => {
    const credential = readCredential({
      credential: { type: "basic_auth" },
      fields: [{ name: "password", value: "hunter2", secret: true }],
    });
    const { slots, extra } = credentialSlotViews(credential);
    expect(slots.find((slot) => slot.key === "password")?.value).toBe("hunter2");
    expect(extra).toHaveLength(0);
  });

  it("reports the required slots that are still empty", () => {
    expect(missingCredentialSlots(emptyCredential("api_key")).map((slot) => slot.key)).toEqual(["api_key"]);
    expect(missingCredentialSlots(readCredential({ credential: { type: "custom" }, fields: [] }))).toEqual([]);
  });
});

describe("redactCredentialData", () => {
  it("keeps every bit of shape and no value at all", () => {
    const data = writeCredential({
      ...emptyCredential("api_key", "prod"),
      service: "Stripe",
      fields: [
        { key: "api_key", name: "API key", value: "sk_live_REAL", secret: true },
        { key: "base_url", name: "Base URL", value: "https://api.stripe.com", secret: false },
      ],
    });
    const redacted = redactCredentialData(data, "node-1");
    expect(JSON.stringify(redacted)).not.toContain("sk_live_REAL");
    // A non-secret value is redacted too: the shape is the contract, not the content.
    expect(JSON.stringify(redacted)).not.toContain("api.stripe.com");
    const meta = redacted.credential as Record<string, unknown>;
    expect(meta.type).toBe("api_key");
    expect(meta.environment).toBe("prod");
    expect(meta.service).toBe("Stripe");
    const fields = redacted.fields as Array<Record<string, unknown>>;
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ key: "api_key", name: "API key", secret: true, value: REDACTED_VALUE, ref: "bx://credential/node-1#api_key" });
  });

  it("drops any key that is not `credential` or `fields`", () => {
    const redacted = redactCredentialData({ fields: [], stashed_password: "hunter2", notes: "x" });
    expect(Object.keys(redacted).sort()).toEqual(["credential", "fields"]);
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
  });
});

describe("credential references", () => {
  it("round-trips", () => {
    const ref = credentialRef("abc-123", "secret_key");
    expect(ref).toBe("bx://credential/abc-123#secret_key");
    expect(parseCredentialRef(ref)).toEqual({ nodeId: "abc-123", fieldKey: "secret_key" });
    expect(parseCredentialRef("not a ref")).toBeNull();
  });

  it("names an environment variable from the service and the field", () => {
    const credential = { ...emptyCredential("api_key", "prod"), service: "Stripe" };
    expect(credentialEnvName(credential, { key: "secret_key", name: "Secret key" })).toBe("STRIPE_SECRET_KEY");
    expect(credentialEnvName({ ...credential, service: null }, { key: "api_key", name: "API key" }, "Résend — API key")).toBe("RESEND_API_KEY_API_KEY");
  });
});

describe("the type catalogue", () => {
  it("has unique ids and unique slot keys, and ends in custom", () => {
    const ids = CREDENTIAL_TYPES.map((type) => type.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe("custom");
    for (const type of CREDENTIAL_TYPES) {
      const keys = type.slots.map((slot) => slot.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("the changes feed", () => {
  it("never persists a credential's values in its snapshot", async () => {
    const { nodeChangeSnapshot } = await import("./changes.js");
    const snapshot = nodeChangeSnapshot({
      id: "node-9",
      workspace_id: "ws",
      parent_id: null,
      kind: "credential",
      slug: "stripe-keys",
      title: "Stripe — API keys",
      content_md: "Billing keys.",
      status: null,
      priority: null,
      due_date: null,
      position: 0,
      tags: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      data: {
        credential: { schema_version: 1, type: "api_key", environment: "prod", service: "Stripe" },
        // `value` is not a name any sensitive-key heuristic recognises, which
        // is exactly why the redaction here is by kind and not by key.
        fields: [{ key: "api_key", name: "API key", value: "sk_live_LEAK", secret: true }],
      },
    } as never);
    expect(JSON.stringify(snapshot)).not.toContain("sk_live_LEAK");
    expect((snapshot.data.credential as Record<string, unknown>).environment).toBe("prod");
  });
});
