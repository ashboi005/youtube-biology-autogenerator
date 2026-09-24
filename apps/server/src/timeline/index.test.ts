import { describe, expect, test } from "bun:test";

import { buildPlan, keepRanges, mapRange, mergeRanges, type ClipInput } from "./index";

const clip = (over: Partial<ClipInput> = {}): ClipInput => ({
  id: "c1",
  durationSec: 60,
  hasAudio: true,
  isHdr: false,
  cuts: [],
  overlays: [],
  voiceovers: [],
  ...over,
});

describe("mergeRanges", () => {
  test("merges overlapping, adjacent and unsorted ranges", () => {
    expect(
      mergeRanges([
        { start: 20, end: 30 },
        { start: 1, end: 5 },
        { start: 4, end: 8 },
        { start: 8, end: 10 },
      ]),
    ).toEqual([
      { start: 1, end: 10 },
      { start: 20, end: 30 },
    ]);
  });

  test("drops inverted or empty ranges", () => {
    expect(mergeRanges([{ start: 5, end: 5 }, { start: 9, end: 3 }])).toEqual([]);
  });
});

describe("keepRanges", () => {
  test("no cuts keeps whole clip", () => {
    expect(keepRanges(60, [])).toEqual([{ start: 0, end: 60 }]);
  });

  test("cuts are clamped to clip bounds and complemented", () => {
    expect(
      keepRanges(60, [
        { start: -5, end: 2 },
        { start: 10, end: 20 },
        { start: 55, end: 99 },
      ]),
    ).toEqual([
      { start: 2, end: 10 },
      { start: 20, end: 55 },
    ]);
  });

  test("overlapping cuts merge", () => {
    expect(keepRanges(30, [{ start: 5, end: 15 }, { start: 10, end: 20 }])).toEqual([
      { start: 0, end: 5 },
      { start: 20, end: 30 },
    ]);
  });

  test("slivers shorter than 50ms are dropped", () => {
    expect(keepRanges(10, [{ start: 0.02, end: 10 }])).toEqual([]);
  });
});

describe("mapRange", () => {
  const keep = [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ];

  test("range inside a keep segment maps directly", () => {
    expect(mapRange(keep, { start: 2, end: 4 })).toEqual([{ start: 2, end: 4 }]);
  });

  test("range after a cut is shifted left", () => {
    expect(mapRange(keep, { start: 22, end: 25 })).toEqual([{ start: 12, end: 15 }]);
  });

  test("range spanning a cut becomes one continuous output range", () => {
    expect(mapRange(keep, { start: 8, end: 24 })).toEqual([{ start: 8, end: 14 }]);
  });

  test("range fully inside a cut is dropped", () => {
    expect(mapRange(keep, { start: 12, end: 18 })).toEqual([]);
  });
});

describe("buildPlan", () => {
  test("offsets clips sequentially and totals content duration", () => {
    const plan = buildPlan([
      clip({ id: "a", durationSec: 30, cuts: [{ start: 10, end: 20 }] }),
      clip({ id: "b", durationSec: 15 }),
    ]);
    expect(plan.clips.map((c) => [c.id, c.outputOffset, c.outputDuration])).toEqual([
      ["a", 0, 20],
      ["b", 20, 15],
    ]);
    expect(plan.contentDuration).toBe(35);
  });

  test("overlay on second clip lands in content time, clamped by cuts", () => {
    const plan = buildPlan([
      clip({ id: "a", durationSec: 20 }),
      clip({
        id: "b",
        durationSec: 20,
        cuts: [{ start: 12, end: 20 }],
        overlays: [{ start: 10, end: 14, text: "Mitosis", position: "top" }],
      }),
    ]);
    expect(plan.overlays).toEqual([{ start: 30, end: 32, text: "Mitosis", position: "top" }]);
  });

  test("overlay fully inside a cut is dropped", () => {
    const plan = buildPlan([
      clip({
        cuts: [{ start: 5, end: 15 }],
        overlays: [{ start: 6, end: 9, text: "x", position: "bottom" }],
      }),
    ]);
    expect(plan.overlays).toEqual([]);
  });

  test("voiceover split by a cut keeps source offsets into the recording", () => {
    const plan = buildPlan([
      clip({
        durationSec: 60,
        cuts: [{ start: 12, end: 14 }],
        voiceovers: [{ id: "v1", start: 10, end: 20 }],
      }),
    ]);
    expect(plan.voiceovers).toEqual([
      { id: "v1", start: 10, end: 12, srcOffset: 0 },
      { id: "v1", start: 12, end: 18, srcOffset: 4 },
    ]);
  });

  test("clip that is entirely cut contributes nothing", () => {
    const plan = buildPlan([
      clip({ id: "a", durationSec: 10, cuts: [{ start: 0, end: 10 }] }),
      clip({ id: "b", durationSec: 5 }),
    ]);
    expect(plan.clips.map((c) => c.id)).toEqual(["b"]);
    expect(plan.contentDuration).toBe(5);
  });
});
