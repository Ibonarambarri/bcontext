import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_EMBEDDING_VERSION,
  currentEmbeddingVersion,
  currentVersionFilter,
  isCurrentEmbeddingVersion,
  staleEmbeddingsQuery,
  summarizeMigration,
} from "./embedding-version";

const ORIG_ENV = process.env.EMBEDDING_MODEL;

describe("embedding-version helpers", () => {
  beforeEach(() => {
    process.env.EMBEDDING_MODEL = "openai/text-embedding-3-small";
  });
  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.EMBEDDING_MODEL;
    else process.env.EMBEDDING_MODEL = ORIG_ENV;
  });

  it("currentEmbeddingVersion mirrors EMBEDDING_MODEL", () => {
    expect(currentEmbeddingVersion()).toBe("openai/text-embedding-3-small");
    process.env.EMBEDDING_MODEL = "voyage-3";
    expect(currentEmbeddingVersion()).toBe("voyage-3");
  });

  it("currentVersionFilter returns the column + active model", () => {
    expect(currentVersionFilter()).toEqual({
      column: "embedding_version",
      value: "openai/text-embedding-3-small",
    });
  });

  it("isCurrentEmbeddingVersion compares exact match", () => {
    expect(isCurrentEmbeddingVersion("openai/text-embedding-3-small")).toBe(true);
    expect(isCurrentEmbeddingVersion("voyage-3")).toBe(false);
    expect(isCurrentEmbeddingVersion(LEGACY_EMBEDDING_VERSION)).toBe(false);
    expect(isCurrentEmbeddingVersion(null)).toBe(false);
    expect(isCurrentEmbeddingVersion(undefined)).toBe(false);
    expect(isCurrentEmbeddingVersion("")).toBe(false);
  });

  it("staleEmbeddingsQuery emits a !=-style filter against current", () => {
    const q = staleEmbeddingsQuery();
    expect(q).toEqual({
      table: "embeddings",
      column: "embedding_version",
      notEqual: "openai/text-embedding-3-small",
    });
    // Explicit override is honoured (callers can pin a snapshot).
    expect(staleEmbeddingsQuery("voyage-3")).toEqual({
      table: "embeddings",
      column: "embedding_version",
      notEqual: "voyage-3",
    });
  });

  describe("summarizeMigration", () => {
    it("reports all-done when every row matches the current model", () => {
      const status = summarizeMigration([
        { embedding_version: "openai/text-embedding-3-small", count: 42 },
      ]);
      expect(status).toEqual({
        migrating_from: null,
        migrating_to: "openai/text-embedding-3-small",
        total: 42,
        done: 42,
        stale: 0,
      });
    });

    it("reports stale rows + their source version", () => {
      const status = summarizeMigration([
        { embedding_version: "openai/text-embedding-3-small", count: 10 },
        { embedding_version: "legacy", count: 7 },
      ]);
      expect(status.migrating_from).toBe("legacy");
      expect(status.migrating_to).toBe("openai/text-embedding-3-small");
      expect(status.done).toBe(10);
      expect(status.stale).toBe(7);
      expect(status.total).toBe(17);
    });

    it("treats null embedding_version as legacy", () => {
      const status = summarizeMigration([
        { embedding_version: null, count: 3 },
      ]);
      expect(status.migrating_from).toBe(LEGACY_EMBEDDING_VERSION);
      expect(status.stale).toBe(3);
      expect(status.done).toBe(0);
    });

    it("clamps negative / NaN counts to zero", () => {
      const status = summarizeMigration([
        { embedding_version: "openai/text-embedding-3-small", count: -5 },
        { embedding_version: "legacy", count: Number.NaN },
      ]);
      expect(status.done).toBe(0);
      expect(status.stale).toBe(0);
      expect(status.total).toBe(0);
      // No real stale rows → no `migrating_from`.
      expect(status.migrating_from).toBe(null);
    });

    it("respects an explicit current override", () => {
      const status = summarizeMigration(
        [
          { embedding_version: "voyage-3", count: 5 },
          { embedding_version: "openai/text-embedding-3-small", count: 2 },
        ],
        "voyage-3",
      );
      expect(status.migrating_to).toBe("voyage-3");
      expect(status.done).toBe(5);
      expect(status.stale).toBe(2);
      expect(status.migrating_from).toBe("openai/text-embedding-3-small");
    });
  });
});
