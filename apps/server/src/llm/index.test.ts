import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";

import { createRateLimiter, DEFAULT_THUMBNAIL_TEMPLATE, generateThumbnailPrompt } from "./index";

const mockModel = (text: string, seen: unknown[] = []) =>
  new MockLanguageModelV3({
    doGenerate: async (opts) => {
      seen.push(opts.prompt);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });

describe("generateThumbnailPrompt", () => {
  test("sends template as system and title/description as user, returns trimmed text", async () => {
    const seen: unknown[] = [];
    const out = await generateThumbnailPrompt(
      { title: "Mitosis in 5 minutes", description: "Phases of cell division", template: "TEMPLATE" },
      mockModel("  A bold 16:9 thumbnail...  \n", seen),
    );
    expect(out).toBe("A bold 16:9 thumbnail...");
    const json = JSON.stringify(seen[0]);
    expect(json).toContain("TEMPLATE");
    expect(json).toContain("Mitosis in 5 minutes");
    expect(json).toContain("Phases of cell division");
  });

  test("falls back to the default template when none is set", async () => {
    const seen: unknown[] = [];
    await generateThumbnailPrompt({ title: "t", description: "d", template: null }, mockModel("x", seen));
    expect(JSON.stringify(seen[0])).toContain(DEFAULT_THUMBNAIL_TEMPLATE.slice(0, 40));
  });

  test("empty model output is an error", async () => {
    expect(
      generateThumbnailPrompt({ title: "t", description: "d", template: "T" }, mockModel("   ")),
    ).rejects.toThrow(/empty/i);
  });
});

describe("createRateLimiter", () => {
  test("allows N calls per window per user", () => {
    let now = 0;
    const limit = createRateLimiter(2, 1000, () => now);
    expect(limit("u1")).toBe(true);
    expect(limit("u1")).toBe(true);
    expect(limit("u1")).toBe(false);
    expect(limit("u2")).toBe(true);
    now = 1001;
    expect(limit("u1")).toBe(true);
  });
});
