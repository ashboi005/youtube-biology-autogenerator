import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probe } from "../render/probe";
import { runFfmpeg } from "../render/run";
import { YoutubeError } from "../youtube/client";
import { renderAndUpload, type JobDeps, type JobInput, type StatusPatch } from "./render-and-upload";

const HAS_DRAWTEXT = Bun.spawnSync(["ffmpeg", "-hide_banner", "-filters"]).stdout.toString().includes(" drawtext ");

let fixtures: string;
let workRoot: string;

const gen = (args: string[]) => {
  const r = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "job-fixtures-"));
  workRoot = await mkdtemp(join(tmpdir(), "job-work-"));
  gen(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=29.97:d=8", "-f", "lavfi", "-i", "sine=f=440:d=8",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", join(fixtures, "a.mov")]);
  gen(["-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:d=4", "-c:v", "libx264", "-preset", "ultrafast",
    join(fixtures, "b.mov")]); // no audio track
  gen(["-f", "lavfi", "-i", "smptebars=size=1920x1080:rate=30:d=3", "-f", "lavfi", "-i", "sine=f=880:d=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", join(fixtures, "intro.mp4")]);
  gen(["-f", "lavfi", "-i", "sine=f=220:d=5", "-c:a", "aac", join(fixtures, "v1.m4a")]);
  gen(["-f", "lavfi", "-i", "color=c=blue:s=1280x720:d=1", "-frames:v", "1", join(fixtures, "thumb.jpg")]);
});

afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
  await rm(workRoot, { recursive: true, force: true });
});

function input(overrides: Partial<JobInput> = {}): JobInput {
  return {
    project: { id: "p1", title: "Mitosis", description: "Cell division", privacy: "private", thumbnailKey: "thumb" },
    clips: [
      {
        id: "a", objectKey: "a", sizeBytes: 1000, durationSec: 8, hasAudio: true, isHdr: false,
        cuts: [{ startSec: 2, endSec: 3 }],
        overlays: HAS_DRAWTEXT ? [{ startSec: 1, endSec: 4, text: `It's 50% "easy": C:\\x`, position: "top" }] : [],
        voiceovers: [{ id: "v1", startSec: 4, endSec: 6, objectKey: "v1", ready: true }],
      },
      { id: "b", objectKey: "b", sizeBytes: 1000, durationSec: 4, hasAudio: false, isHdr: false, cuts: [], overlays: [], voiceovers: [] },
    ],
    settings: { introKey: "intro", outroKey: null, fadeSeconds: 1, audioCleanup: true },
    refreshToken: "rt",
    ...overrides,
  };
}

const files: Record<string, string> = { a: "a.mov", b: "b.mov", intro: "intro.mp4", v1: "v1.m4a", thumb: "thumb.jpg" };

function deps(over: Partial<JobDeps> = {}) {
  const statuses: StatusPatch[] = [];
  const uploads: { title: string; privacy: string; duration: number }[] = [];
  const thumbs: string[] = [];
  const d: JobDeps = {
    load: async () => input(),
    setStatus: async (_id, patch) => {
      statuses.push(patch);
    },
    download: async (key, path) => copyFile(join(fixtures, files[key]!), path),
    probe,
    runFfmpeg,
    uploadVideo: async (i) => {
      const info = await probe(i.filePath);
      uploads.push({ title: i.title, privacy: i.privacy, duration: info.durationSec });
      expect(info).toMatchObject({ width: 1920, height: 1080 });
      i.onProgress(1);
      return "yt123";
    },
    setThumbnail: async (_rt, videoId, path) => {
      thumbs.push(`${videoId}:${path.endsWith(".jpg")}`);
    },
    freeBytes: async () => 100 * 1024 ** 3,
    workDir: workRoot,
    fontPath: "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    sleep: async () => {},
    ...over,
  };
  return { d, statuses, uploads, thumbs };
}

describe("renderAndUpload", () => {
  test("renders intro + cut + voiceover + silent clip, uploads, sets thumbnail, cleans up", async () => {
    const { d, statuses, uploads, thumbs } = deps();
    await renderAndUpload("p1", "job1", d);

    // intro 3 + clip a (8 - 1 cut) + clip b 4 - fade 1 = 13
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.duration).toBeCloseTo(13, 0);
    expect(uploads[0]).toMatchObject({ title: "Mitosis", privacy: "private" });
    expect(thumbs).toEqual(["yt123:true"]);
    expect(statuses[0]).toMatchObject({ status: "rendering", progress: 0 });
    expect(statuses.at(-1)).toEqual({ status: "done", progress: 100, youtubeVideoId: "yt123", errorMessage: null });
    expect(await readdir(workRoot)).toEqual([]);
  }, 120_000);

  test("fails early with a clear message when disk is low, and downloads nothing", async () => {
    let downloads = 0;
    const { d, statuses } = deps({
      freeBytes: async () => 100,
      download: async () => {
        downloads++;
      },
    });
    await renderAndUpload("p1", "job2", d);
    expect(downloads).toBe(0);
    expect(statuses.at(-1)).toMatchObject({ status: "failed", errorMessage: "Server is out of space — ask admin" });
    expect(await readdir(workRoot)).toEqual([]);
  });

  test("retries a flaky YouTube upload, then succeeds", async () => {
    let attempts = 0;
    const { d, statuses } = deps({
      uploadVideo: async () => {
        if (++attempts < 3) throw new YoutubeError("YOUTUBE_OTHER", "network");
        return "yt9";
      },
      runFfmpeg: async (args) => {
        await Bun.write(args.at(-1)!, "fake");
      },
      load: async () => input({ project: { ...input().project, thumbnailKey: null } }),
    });
    await renderAndUpload("p1", "job3", d);
    expect(attempts).toBe(3);
    expect(statuses.at(-1)).toMatchObject({ status: "done", youtubeVideoId: "yt9" });
  });

  test("does not retry a revoked token, and reports it in plain English", async () => {
    let attempts = 0;
    const { d, statuses } = deps({
      uploadVideo: async () => {
        attempts++;
        throw new YoutubeError("YOUTUBE_RECONNECT", "YouTube needs reconnecting (ask admin)");
      },
      runFfmpeg: async (args) => {
        await Bun.write(args.at(-1)!, "fake");
      },
    });
    await renderAndUpload("p1", "job4", d);
    expect(attempts).toBe(1);
    expect(statuses.at(-1)).toMatchObject({ status: "failed", errorMessage: "YouTube needs reconnecting (ask admin)" });
    expect(await readdir(workRoot)).toEqual([]);
  });

  test("thumbnail failure still finishes the upload with a note", async () => {
    const { d, statuses } = deps({
      runFfmpeg: async (args) => {
        await Bun.write(args.at(-1)!, "fake");
      },
      uploadVideo: async () => "yt5",
      setThumbnail: async () => {
        throw new YoutubeError("YOUTUBE_OTHER", "forbidden");
      },
    });
    await renderAndUpload("p1", "job5", d);
    expect(statuses.at(-1)).toMatchObject({ status: "done", youtubeVideoId: "yt5" });
    expect(statuses.at(-1)!.errorMessage).toContain("thumbnail");
  });

  test("ffmpeg failure is reported and the work dir is removed", async () => {
    const { d, statuses } = deps({
      runFfmpeg: async () => {
        throw new Error("boom");
      },
    });
    await renderAndUpload("p1", "job6", d);
    expect(statuses.at(-1)).toMatchObject({ status: "failed", errorMessage: "Rendering failed — tap Try again, or ask for help" });
    expect(await readdir(workRoot)).toEqual([]);
  });
});
