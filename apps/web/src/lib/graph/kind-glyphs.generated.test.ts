import { describe, expect, it } from "vitest";
import { buildGlyphBodies, renderModule } from "../../../scripts/generate-kind-glyphs.mjs";
import { readFileSync } from "node:fs";

describe("kind-glyphs.generated.ts", () => {
  it("still matches the installed lucide package", () => {
    // The committed file is DERIVED from lucide-react. If a version bump
    // reshapes a glyph, this fails instead of letting the canvas quietly
    // diverge from the icon the lists draw.
    //
    // To fix a failure: npm run generate:kind-glyphs
    const committed = readFileSync(new URL("./kind-glyphs.generated.ts", import.meta.url), "utf8");
    expect(committed).toBe(renderModule(buildGlyphBodies()));
  });
});
