import { clip, project } from "@youtube-biology-autogenerator/db/schema/index";
import { and, desc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { enqueueRender } from "../jobs/queue";
import { createRateLimiter, generateThumbnailPrompt } from "../llm";
import { db } from "../services";
import { headExists, presignGet, presignPut, thumbKey } from "../storage";
import { HttpError, isAdmin, validateSendable, youtubeTextProblems } from "./access";
import { authContext } from "./context";
import {
  claimForSend,
  getSettings,
  getYoutubeConnection,
  loadEditableProject,
  loadProject,
  loadTimeline,
} from "./repo";

const llmLimit = createRateLimiter(10, 60 * 60 * 1000);

export const projectRoutes = new Elysia({ prefix: "/projects" })
  .use(authContext)
  .get(
    "/",
    async ({ user }) => {
      const q = db.select().from(project).orderBy(desc(project.updatedAt));
      return isAdmin(user) ? q : q.where(eq(project.ownerId, user.id));
    },
    { auth: true },
  )
  .post(
    "/",
    async ({ user, body }) => {
      const [p] = await db
        .insert(project)
        .values({ ownerId: user.id, title: body.title?.trim() ?? "" })
        .returning();
      return p!;
    },
    { auth: true, body: t.Object({ title: t.Optional(t.String({ maxLength: 100 })) }) },
  )
  .get(
    "/:id",
    async ({ user, params }) => {
      const p = await loadProject(user, params.id);
      const [clips, yt] = await Promise.all([loadTimeline(p.id), getYoutubeConnection()]);
      return {
        project: p,
        clips,
        youtubeConnected: Boolean(yt),
        problems: validateSendable({ ...p, clips, youtubeConnected: Boolean(yt) }),
      };
    },
    { auth: true },
  )
  .patch(
    "/:id",
    async ({ user, params, body }) => {
      const current = await loadEditableProject(user, params.id);
      const problems = youtubeTextProblems(body.title ?? current.title, body.description ?? current.description);
      if (problems.length) throw new HttpError(400, problems.join(". "));
      const [p] = await db.update(project).set(body).where(eq(project.id, params.id)).returning();
      return p!;
    },
    {
      auth: true,
      body: t.Object({
        title: t.Optional(t.String({ maxLength: 100 })),
        description: t.Optional(t.String({ maxLength: 5000 })),
        privacy: t.Optional(t.Union([t.Literal("private"), t.Literal("unlisted")])),
      }),
    },
  )
  .delete(
    "/:id",
    async ({ user, params }) => {
      await loadEditableProject(user, params.id);
      await db.delete(project).where(eq(project.id, params.id));
      return { ok: true };
    },
    { auth: true },
  )
  .post(
    "/:id/thumbnail-prompt",
    async ({ user, params }) => {
      const p = await loadProject(user, params.id);
      if (!p.title.trim() || !p.description.trim()) {
        throw new HttpError(400, "Fill in the title and description first");
      }
      if (!llmLimit(user.id)) throw new HttpError(429, "That's a lot of prompts — try again in an hour");
      const settings = await getSettings();
      let prompt: string;
      try {
        prompt = await generateThumbnailPrompt({
          title: p.title,
          description: p.description,
          template: settings.thumbnailPromptTemplate,
        });
      } catch (err) {
        console.error("[llm]", err);
        throw new HttpError(502, "The AI didn't answer — tap to try again");
      }
      await db.update(project).set({ thumbnailPrompt: prompt }).where(eq(project.id, p.id));
      return { prompt };
    },
    { auth: true },
  )
  .post(
    "/:id/thumbnail",
    async ({ user, params }) => {
      const p = await loadEditableProject(user, params.id);
      return { uploadUrl: await presignPut(thumbKey(p.id), "image/jpeg") };
    },
    { auth: true },
  )
  .post(
    "/:id/thumbnail/complete",
    async ({ user, params }) => {
      const p = await loadEditableProject(user, params.id);
      const key = thumbKey(p.id);
      if (!(await headExists(key))) throw new HttpError(400, "The thumbnail didn't upload — try again");
      await db.update(project).set({ thumbnailKey: key }).where(eq(project.id, p.id));
      return { url: await presignGet(key) };
    },
    { auth: true },
  )
  .get(
    "/:id/thumbnail-url",
    async ({ user, params }) => {
      const p = await loadProject(user, params.id);
      return { url: p.thumbnailKey ? await presignGet(p.thumbnailKey) : null };
    },
    { auth: true },
  )
  .put(
    "/:id/clips/order",
    async ({ user, params, body }) => {
      await loadEditableProject(user, params.id);
      await db.transaction(async (tx) => {
        for (const [position, clipId] of body.clipIds.entries()) {
          await tx
            .update(clip)
            .set({ position })
            .where(and(eq(clip.id, clipId), eq(clip.projectId, params.id)));
        }
      });
      return { ok: true };
    },
    { auth: true, body: t.Object({ clipIds: t.Array(t.String(), { maxItems: 100 }) }) },
  )
  .post(
    "/:id/send",
    async ({ user, params }) => {
      const p = await loadProject(user, params.id);
      const [clips, yt] = await Promise.all([loadTimeline(p.id), getYoutubeConnection()]);
      const problems = validateSendable({ ...p, clips, youtubeConnected: Boolean(yt) });
      if (problems.length) throw new HttpError(400, problems.join(". "));
      const claimed = await claimForSend(p.id);
      if (!claimed) throw new HttpError(409, "This video is already being processed");
      try {
        await enqueueRender(p.id);
      } catch (err) {
        console.error("[send] enqueue failed", err);
        await db
          .update(project)
          .set({ status: "failed", errorMessage: "Couldn't start — tap Try again" })
          .where(eq(project.id, p.id));
        throw new HttpError(503, "Couldn't start — tap Try again");
      }
      return claimed;
    },
    { auth: true },
  );
