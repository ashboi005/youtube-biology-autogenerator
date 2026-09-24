import { clip } from "@youtube-biology-autogenerator/db/schema/index";
import { eq, max } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { probe } from "../render/probe";
import { db } from "../services";
import {
  abortMultipart,
  clipKey,
  completeMultipart,
  createMultipart,
  listParts,
  presignGet,
  signPart,
} from "../storage";
import { HttpError } from "./access";
import { authContext } from "./context";
import { loadClip, loadEditableProject } from "./repo";

const MAX_CLIP_BYTES = 20 * 1024 ** 3; // 20 GB — far above a 15-min iPhone clip

export const clipRoutes = new Elysia()
  .use(authContext)
  .post(
    "/projects/:id/clips",
    async ({ user, params, body }) => {
      const p = await loadEditableProject(user, params.id);
      if (!body.contentType.startsWith("video/")) throw new HttpError(400, "That file isn't a video");
      const [{ value } = { value: null }] = await db
        .select({ value: max(clip.position) })
        .from(clip)
        .where(eq(clip.projectId, p.id));
      const id = crypto.randomUUID();
      const key = clipKey(p.id, id, body.fileName);
      const uploadId = await createMultipart(key, body.contentType);
      const [c] = await db
        .insert(clip)
        .values({
          id,
          projectId: p.id,
          position: (value ?? -1) + 1,
          objectKey: key,
          uploadId,
          originalName: body.fileName.slice(0, 200),
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
        })
        .returning();
      return { clip: c!, key, uploadId };
    },
    {
      auth: true,
      body: t.Object({
        fileName: t.String({ minLength: 1, maxLength: 500 }),
        contentType: t.String({ maxLength: 100 }),
        sizeBytes: t.Number({ minimum: 1, maximum: MAX_CLIP_BYTES }),
      }),
    },
  )
  .post(
    "/clips/:id/sign-part",
    async ({ user, params, body }) => {
      const { clip: c } = await loadClip(user, params.id, true);
      if (!c.uploadId || c.uploadState !== "uploading") throw new HttpError(409, "This clip isn't uploading");
      return { url: await signPart(c.objectKey, c.uploadId, body.partNumber) };
    },
    { auth: true, body: t.Object({ partNumber: t.Integer({ minimum: 1, maximum: 10000 }) }) },
  )
  .get(
    "/clips/:id/parts",
    async ({ user, params }) => {
      const { clip: c } = await loadClip(user, params.id, true);
      if (!c.uploadId) throw new HttpError(409, "This clip isn't uploading");
      return listParts(c.objectKey, c.uploadId);
    },
    { auth: true },
  )
  .post(
    "/clips/:id/complete",
    async ({ user, params, body }) => {
      const { clip: c } = await loadClip(user, params.id, true);
      if (!c.uploadId) throw new HttpError(409, "This clip isn't uploading");
      await completeMultipart(c.objectKey, c.uploadId, body.parts);
      try {
        const info = await probe(await presignGet(c.objectKey, 600));
        const [updated] = await db
          .update(clip)
          .set({ ...info, uploadState: "ready", uploadId: null })
          .where(eq(clip.id, c.id))
          .returning();
        return updated!;
      } catch (err) {
        console.error("[probe]", err);
        await db.update(clip).set({ uploadState: "failed", uploadId: null }).where(eq(clip.id, c.id));
        throw new HttpError(400, "This file isn't a video we can read");
      }
    },
    {
      auth: true,
      body: t.Object({
        parts: t.Array(t.Object({ PartNumber: t.Integer({ minimum: 1 }), ETag: t.String() }), { maxItems: 10000 }),
      }),
    },
  )
  .post(
    "/clips/:id/abort",
    async ({ user, params }) => {
      const { clip: c } = await loadClip(user, params.id, true);
      if (c.uploadId) await abortMultipart(c.objectKey, c.uploadId).catch(() => {});
      await db.delete(clip).where(eq(clip.id, c.id));
      return { ok: true };
    },
    { auth: true },
  )
  .delete(
    "/clips/:id",
    async ({ user, params }) => {
      const { clip: c } = await loadClip(user, params.id, true);
      if (c.uploadId) await abortMultipart(c.objectKey, c.uploadId).catch(() => {});
      // The object itself is removed by the bucket lifecycle rule.
      await db.delete(clip).where(eq(clip.id, c.id));
      return { ok: true };
    },
    { auth: true },
  )
  .get(
    "/clips/:id/url",
    async ({ user, params }) => {
      const { clip: c } = await loadClip(user, params.id);
      return { url: await presignGet(c.objectKey) };
    },
    { auth: true },
  );
