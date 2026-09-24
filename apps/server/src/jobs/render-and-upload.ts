import { mkdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";

import { buildFfmpegArgs, type Bumper } from "../render/args";
import type { ProbeResult } from "../render/probe";
import { buildPlan, type ClipInput, type OverlayPosition } from "../timeline";
import { YoutubeError, type UploadInput } from "../youtube/client";

type Status = "rendering" | "uploading" | "done" | "failed";
export type StatusPatch = {
  status?: Status;
  progress?: number;
  errorMessage?: string | null;
  youtubeVideoId?: string | null;
};

type RangeRow = { startSec: number; endSec: number };

export type JobInput = {
  project: {
    id: string;
    title: string;
    description: string;
    privacy: "private" | "unlisted";
    thumbnailKey: string | null;
  };
  clips: {
    id: string;
    objectKey: string;
    sizeBytes: number;
    durationSec: number | null;
    hasAudio: boolean;
    isHdr: boolean;
    cuts: RangeRow[];
    overlays: (RangeRow & { text: string; position: OverlayPosition })[];
    voiceovers: (RangeRow & { id: string; objectKey: string; ready: boolean })[];
  }[];
  settings: { introKey: string | null; outroKey: string | null; fadeSeconds: number; audioCleanup: boolean };
  refreshToken: string;
};

export type JobDeps = {
  load(projectId: string): Promise<JobInput>;
  setStatus(projectId: string, patch: StatusPatch): Promise<void>;
  download(key: string, path: string): Promise<void>;
  probe(path: string): Promise<ProbeResult>;
  runFfmpeg(args: string[], totalDuration: number, onProgress: (pct: number) => void): Promise<void>;
  uploadVideo(input: Omit<UploadInput, "refreshToken"> & { refreshToken: string }): Promise<string>;
  setThumbnail(refreshToken: string, videoId: string, path: string): Promise<void>;
  freeBytes(dir: string): Promise<number>;
  workDir: string;
  fontPath: string;
  sleep(ms: number): Promise<void>;
};

class UserFacingError extends Error {}

const DISK_FACTOR = 3;
const PROGRESS_WRITE_MS = 2000;
const UPLOAD_ATTEMPTS = 3;
const RENDER_SHARE = 80; // progress 0-80 render, 80-100 upload

const extOf = (key: string) => key.slice(key.lastIndexOf(".") + 1) || "bin";

function throttled(fn: (pct: number) => void) {
  let last = 0;
  let lastPct = -1;
  return (pct: number) => {
    const now = Date.now();
    if (pct !== lastPct && (now - last >= PROGRESS_WRITE_MS || pct >= 100)) {
      last = now;
      lastPct = pct;
      fn(pct);
    }
  };
}

export async function renderAndUpload(projectId: string, jobId: string, deps: JobDeps): Promise<void> {
  const dir = join(deps.workDir, jobId);
  const set = (patch: StatusPatch) => deps.setStatus(projectId, patch);

  try {
    await set({ status: "rendering", progress: 0, errorMessage: null });
    const job = await deps.load(projectId);
    const clips = job.clips.filter((c) => c.durationSec);

    // 1. Disk check before touching the network.
    const inputBytes = clips.reduce((s, c) => s + c.sizeBytes, 0);
    if ((await deps.freeBytes(deps.workDir)) < inputBytes * DISK_FACTOR) {
      throw new UserFacingError("Server is out of space — ask admin");
    }
    await mkdir(dir, { recursive: true });

    // 2. Stream inputs to disk.
    const clipPaths: Record<string, string> = {};
    const voPaths: Record<string, string> = {};
    try {
      for (const c of clips) {
        clipPaths[c.id] = join(dir, `clip-${c.id}.${extOf(c.objectKey)}`);
        await deps.download(c.objectKey, clipPaths[c.id]!);
        for (const v of c.voiceovers.filter((v) => v.ready)) {
          voPaths[v.id] = join(dir, `vo-${v.id}.${extOf(v.objectKey)}`);
          await deps.download(v.objectKey, voPaths[v.id]!);
        }
      }
    } catch (err) {
      console.error("[job] download failed", err);
      throw new UserFacingError("Couldn't fetch your clips from storage — tap Try again");
    }

    const bumper = async (key: string | null, name: string): Promise<Bumper | undefined> => {
      if (!key) return undefined;
      const path = join(dir, `${name}.${extOf(key)}`);
      await deps.download(key, path);
      const info = await deps.probe(path);
      return { path, duration: info.durationSec, hasAudio: info.hasAudio };
    };
    const intro = await bumper(job.settings.introKey, "intro");
    const outro = await bumper(job.settings.outroKey, "outro");

    // 3. Plan + render.
    const plan = buildPlan(
      clips.map(
        (c): ClipInput => ({
          id: c.id,
          durationSec: c.durationSec!,
          hasAudio: c.hasAudio,
          isHdr: c.isHdr,
          cuts: c.cuts.map((x) => ({ start: x.startSec, end: x.endSec })),
          overlays: c.overlays.map((x) => ({ start: x.startSec, end: x.endSec, text: x.text, position: x.position })),
          voiceovers: c.voiceovers.filter((v) => v.ready).map((v) => ({ id: v.id, start: v.startSec, end: v.endSec })),
        }),
      ),
    );
    if (plan.clips.length === 0) throw new UserFacingError("Every clip is fully cut — nothing left to upload");

    const outPath = join(dir, "final.mp4");
    const cmd = buildFfmpegArgs({
      plan,
      clipPaths,
      voPaths,
      intro,
      outro,
      fadeSeconds: job.settings.fadeSeconds,
      fontPath: deps.fontPath,
      workDir: dir,
      outPath,
      audioCleanup: job.settings.audioCleanup,
    });
    for (const f of cmd.textFiles) await Bun.write(f.path, f.content);

    const renderProgress = throttled((pct) => {
      void set({ progress: Math.floor((pct * RENDER_SHARE) / 100) });
    });
    try {
      await deps.runFfmpeg(cmd.args, cmd.totalDuration, renderProgress);
    } catch (err) {
      console.error("[job] ffmpeg failed", err);
      throw new UserFacingError("Rendering failed — tap Try again, or ask for help");
    }

    // 4. Upload to YouTube (retry transient failures while the file is still on disk).
    await set({ status: "uploading", progress: RENDER_SHARE });
    const uploadProgress = throttled((pct) => {
      void set({ progress: RENDER_SHARE + Math.floor((pct * (100 - RENDER_SHARE)) / 100) });
    });
    let videoId: string | undefined;
    for (let attempt = 1; !videoId; attempt++) {
      try {
        videoId = await deps.uploadVideo({
          refreshToken: job.refreshToken,
          filePath: outPath,
          title: job.project.title,
          description: job.project.description,
          privacy: job.project.privacy,
          onProgress: (f) => uploadProgress(Math.min(99, Math.floor(f * 100))),
        });
      } catch (err) {
        const retryable = err instanceof YoutubeError && err.code === "YOUTUBE_OTHER";
        if (!retryable || attempt >= UPLOAD_ATTEMPTS) {
          throw new UserFacingError(err instanceof YoutubeError ? err.message : "YouTube upload failed — tap Try again");
        }
        console.warn(`[job] upload attempt ${attempt} failed, retrying`, err);
        await deps.sleep(5000 * 3 ** (attempt - 1));
      }
    }

    // 5. Thumbnail — a failure here shouldn't lose the upload.
    let note: string | null = null;
    if (job.project.thumbnailKey) {
      try {
        const thumbPath = join(dir, "thumb.jpg");
        await deps.download(job.project.thumbnailKey, thumbPath);
        await deps.setThumbnail(job.refreshToken, videoId, thumbPath);
      } catch (err) {
        console.error("[job] thumbnail failed", err);
        note = "Uploaded, but the thumbnail couldn't be set — add it in YouTube Studio";
      }
    }

    await set({ status: "done", progress: 100, youtubeVideoId: videoId, errorMessage: note });
  } catch (err) {
    if (!(err instanceof UserFacingError)) console.error("[job] unexpected failure", err);
    await set({
      status: "failed",
      errorMessage: err instanceof UserFacingError ? err.message : "Something went wrong — tap Try again, or ask for help",
    }).catch((e) => console.error("[job] could not record failure", e));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Real free-space check for `dir` (bytes available to unprivileged users). */
export async function freeBytes(dir: string): Promise<number> {
  await mkdir(dir, { recursive: true });
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}
