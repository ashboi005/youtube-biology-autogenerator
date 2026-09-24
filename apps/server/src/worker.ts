/**
 * Render worker: one job at a time. Run as its own process/container:
 *   bun run src/worker.ts
 */
import { mkdir, rm } from "node:fs/promises";

import { project } from "@youtube-biology-autogenerator/db/schema/index";
import { inArray } from "drizzle-orm";

import { ENV } from "./env.server";
import { realDeps } from "./jobs/deps";
import { getBoss, RENDER_QUEUE, type RenderJobData } from "./jobs/queue";
import { renderAndUpload } from "./jobs/render-and-upload";
import { db } from "./services";

// Crash recovery: nothing can be running before we start, so wipe scratch space and
// mark any in-flight projects as failed so the user sees "Try again".
await rm(ENV.WORK_DIR, { recursive: true, force: true });
await mkdir(ENV.WORK_DIR, { recursive: true });
await db
  .update(project)
  .set({ status: "failed", errorMessage: "The server restarted while processing — tap Try again" })
  .where(inArray(project.status, ["rendering", "uploading"]));

const boss = await getBoss();
await boss.work<RenderJobData>(RENDER_QUEUE, { batchSize: 1 }, async ([job]) => {
  if (!job) return;
  console.log(`[worker] job ${job.id} project ${job.data.projectId}`);
  await renderAndUpload(job.data.projectId, job.id, realDeps);
  console.log(`[worker] job ${job.id} finished`);
});
console.log(`[worker] listening on ${RENDER_QUEUE} (work dir ${ENV.WORK_DIR})`);

const shutdown = async () => {
  await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
