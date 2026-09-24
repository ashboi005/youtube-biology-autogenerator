import { PgBoss } from "pg-boss";

import { ENV } from "../env.server";

export const RENDER_QUEUE = "render-and-upload";
export type RenderJobData = { projectId: string };

let boss: Promise<PgBoss> | undefined;

export function getBoss(): Promise<PgBoss> {
  boss ??= (async () => {
    const b = new PgBoss(ENV.DATABASE_URL);
    b.on("error", (err) => console.error("[pg-boss]", err));
    await b.start();
    await b.createQueue(RENDER_QUEUE, {
      // No automatic retries: a failed job shows "Try again" to the user instead of
      // silently re-rendering (CPU is scarce). Stuck jobs are reset on worker start.
      retryLimit: 0,
      expireInSeconds: 2 * 60 * 60, // 15-min video: ~10 min render + upload, with headroom
    }).catch(() => {}); // already exists
    return b;
  })();
  return boss;
}

export async function enqueueRender(projectId: string): Promise<void> {
  const b = await getBoss();
  await b.send(RENDER_QUEUE, { projectId } satisfies RenderJobData, { singletonKey: projectId });
}
