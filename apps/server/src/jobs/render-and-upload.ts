import { mkdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";

import { buildAssemblyArgs, buildClipPassArgs, type Bumper } from "../render/args";
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
const CLIP_PASS_SHARE = 55; // progress: 0-55 per-clip passes, 55-80 assembly, 80-100 upload
const RENDER_SHARE = 80;

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
  // Progress writes are best-effort and serialized: a DB blip must not crash the worker,
  // and no stale progress may land after a status change.
  let progressChain: Promise<void> = Promise.resolve();
  const progress = throttled((pct: number) => {
    progressChain = progressChain
      .then(() => deps.setStatus(projectId, { progress: Math.floor(pct) }))
      .catch((err) => console.warn("[job] progress write failed", err));
  });
  const set = async (patch: StatusPatch) => {
    await progressChain;
    await deps.setStatus(projectId, patch);
  };

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

    const fetchFile = async (key: string, path: string) => {
      try {
        await deps.download(key, path);
      } catch (err) {
        console.error("[job] download failed", key, err);
        throw new UserFacingError("Couldn't fetch your clips from storage — tap Try again");
      }
    };
    const ffmpeg = async (args: string[], duration: number, onPct: (pct: number) => void) => {
      try {
        await deps.runFfmpeg(args, duration, onPct);
      } catch (err) {
        console.error("[job] ffmpeg failed", err);
        throw new UserFacingError("Rendering failed — tap Try again, or ask for help");
      }
    };

    // 2. Pass 1, one clip at a time: download → cut/normalize to an intermediate → delete the original.
    //    Only one full-resolution decoder is open at once, and originals don't pile up on disk.
    const segmentPaths: Record<string, string> = {};
    const byId = new Map(clips.map((c) => [c.id, c]));
    let doneSec = 0;
    for (const planned of plan.clips) {
      const c = byId.get(planned.id)!;
      const src = join(dir, `clip-${c.id}.${extOf(c.objectKey)}`);
      await fetchFile(c.objectKey, src);
      const seg = join(dir, `seg-${c.id}.mkv`);
      const pass = buildClipPassArgs({ clip: planned, inPath: src, outPath: seg });
      await ffmpeg(pass.args, pass.totalDuration, (pct) =>
        progress(((doneSec + (pct / 100) * planned.outputDuration) / plan.contentDuration) * CLIP_PASS_SHARE),
      );
      await rm(src, { force: true });
      segmentPaths[c.id] = seg;
      doneSec += planned.outputDuration;
    }

    // 3. Pass 2: assemble with voice, text, cleanup and intro/outro.
    const voPaths: Record<string, string> = {};
    for (const c of clips) {
      for (const v of c.voiceovers.filter((v) => v.ready)) {
        voPaths[v.id] = join(dir, `vo-${v.id}.${extOf(v.objectKey)}`);
        await fetchFile(v.objectKey, voPaths[v.id]!);
      }
    }
    const bumper = async (key: string | null, name: string): Promise<Bumper | undefined> => {
      if (!key) return undefined;
      const path = join(dir, `${name}.${extOf(key)}`);
      await fetchFile(key, path);
      const info = await deps.probe(path);
      return { path, duration: info.durationSec, hasAudio: info.hasAudio };
    };
    const intro = await bumper(job.settings.introKey, "intro");
    const outro = await bumper(job.settings.outroKey, "outro");

    const outPath = join(dir, "final.mp4");
    const cmd = buildAssemblyArgs({
      plan,
      segmentPaths,
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
    await ffmpeg(cmd.args, cmd.totalDuration, (pct) =>
      progress(CLIP_PASS_SHARE + (pct / 100) * (RENDER_SHARE - CLIP_PASS_SHARE)),
    );
    for (const p of Object.values(segmentPaths)) await rm(p, { force: true });

    // 4. Upload to YouTube (retry transient failures while the file is still on disk).
    await set({ status: "uploading", progress: RENDER_SHARE });
    let videoId: string | undefined;
    for (let attempt = 1; !videoId; attempt++) {
      try {
        videoId = await deps.uploadVideo({
          refreshToken: job.refreshToken,
          filePath: outPath,
          title: job.project.title,
          description: job.project.description,
          privacy: job.project.privacy,
          onProgress: (f) => progress(RENDER_SHARE + Math.min(0.99, f) * (100 - RENDER_SHARE)),
        });
      } catch (err) {
        // Only transient failures are retried; the resumable upload already retried chunks internally.
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
