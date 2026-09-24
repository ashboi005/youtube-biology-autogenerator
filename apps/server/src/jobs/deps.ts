import { project } from "@youtube-biology-autogenerator/db/schema/index";
import { eq } from "drizzle-orm";

import { ENV } from "../env.server";
import { getSettings, getYoutubeConnection, loadTimeline } from "../routes/repo";
import { probe } from "../render/probe";
import { runFfmpeg } from "../render/run";
import { db } from "../services";
import { downloadToFile } from "../storage";
import { setThumbnail, uploadVideo, YoutubeError } from "../youtube/client";
import { decrypt } from "../youtube/crypto";
import { freeBytes, type JobDeps } from "./render-and-upload";

export const DEFAULT_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

export const realDeps: JobDeps = {
  async load(projectId) {
    const [p] = await db.select().from(project).where(eq(project.id, projectId));
    if (!p) throw new Error(`Project ${projectId} not found`);
    const [clips, settings, yt] = await Promise.all([loadTimeline(p.id), getSettings(), getYoutubeConnection()]);
    if (!yt || !ENV.TOKEN_ENC_KEY) throw new YoutubeError("YOUTUBE_NOT_CONNECTED", "YouTube isn't connected yet (ask admin)");
    return {
      project: p,
      clips: clips.filter((c) => c.uploadState === "ready"),
      settings,
      refreshToken: decrypt(yt.refreshTokenEnc, ENV.TOKEN_ENC_KEY),
    };
  },
  async setStatus(projectId, patch) {
    await db.update(project).set(patch).where(eq(project.id, projectId));
  },
  download: downloadToFile,
  probe,
  runFfmpeg,
  uploadVideo,
  setThumbnail,
  freeBytes,
  workDir: ENV.WORK_DIR,
  fontPath: process.env.FONT_PATH || DEFAULT_FONT,
  sleep: (ms) => Bun.sleep(ms),
};
