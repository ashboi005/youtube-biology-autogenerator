import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseProbe, probe } from "./probe";
import { runFfmpeg } from "./run";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "render-test-"));
  const gen = (args: string[]) =>
    Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args]);
  gen(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:d=2", "-f", "lavfi", "-i", "sine=d=2",
    "-c:v", "libx264", "-c:a", "aac", "-shortest", join(dir, "av.mp4")]);
  gen(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:d=1", "-c:v", "libx264", join(dir, "v.mp4")]);
});

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("probe", () => {
  test("reads duration, size and audio presence", async () => {
    const p = await probe(join(dir, "av.mp4"));
    expect(p.durationSec).toBeCloseTo(2, 1);
    expect(p).toMatchObject({ width: 640, height: 360, hasAudio: true, isHdr: false, rotation: 0 });
  });

  test("detects a video-only file", async () => {
    expect((await probe(join(dir, "v.mp4"))).hasAudio).toBe(false);
  });

  test("rejects a non-video file", async () => {
    await Bun.write(join(dir, "x.txt"), "hello");
    expect(probe(join(dir, "x.txt"))).rejects.toThrow();
  });
});

describe("parseProbe", () => {
  test("HDR (HLG) iPhone clip with rotation swaps dimensions", () => {
    const p = parseProbe({
      format: { duration: "61.2" },
      streams: [
        {
          codec_type: "video",
          width: 1920,
          height: 1080,
          color_transfer: "arib-std-b67",
          side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
        },
        { codec_type: "audio" },
      ],
    });
    expect(p).toEqual({ durationSec: 61.2, width: 1080, height: 1920, rotation: -90, isHdr: true, hasAudio: true });
  });
});

describe("runFfmpeg", () => {
  test("reports progress and resolves on success", async () => {
    const seen: number[] = [];
    await runFfmpeg(
      ["-i", join(dir, "av.mp4"), "-c:v", "libx264", "-preset", "ultrafast", "-y", join(dir, "o.mp4")],
      2,
      (pct) => seen.push(pct),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(100);
    expect(await Bun.file(join(dir, "o.mp4")).exists()).toBe(true);
  });

  test("rejects with stderr tail on failure", async () => {
    expect(runFfmpeg(["-i", join(dir, "missing.mp4"), join(dir, "o2.mp4")], 1, () => {})).rejects.toThrow(
      /missing\.mp4/,
    );
  });
});
