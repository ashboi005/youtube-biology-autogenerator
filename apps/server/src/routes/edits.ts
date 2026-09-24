import { cut, overlay, voiceover } from "@youtube-biology-autogenerator/db/schema/index";
import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { db } from "../services";
import { presignGet, presignPut, voKey } from "../storage";
import { type Actor, HttpError, validateRange } from "./access";
import { authContext } from "./context";
import { loadClip } from "./repo";

const range = { startSec: t.Number(), endSec: t.Number() };

async function editableClip(user: Actor, clipId: string) {
  const res = await loadClip(user, clipId, true);
  if (res.clip.uploadState !== "ready" || !res.clip.durationSec) {
    throw new HttpError(409, "Wait for this clip to finish uploading");
  }
  return { ...res, duration: res.clip.durationSec };
}

async function ownedEdit<T extends { clipId: string }>(user: Actor, row: T | undefined) {
  if (!row) throw new HttpError(404, "Not found");
  await loadClip(user, row.clipId, true);
  return row;
}

export const editRoutes = new Elysia()
  .use(authContext)
  .post(
    "/clips/:id/cuts",
    async ({ user, params, body }) => {
      const { clip: c, duration } = await editableClip(user, params.id);
      validateRange(body.startSec, body.endSec, duration);
      const [row] = await db.insert(cut).values({ clipId: c.id, ...body }).returning();
      return row!;
    },
    { auth: true, body: t.Object(range) },
  )
  .delete(
    "/cuts/:id",
    async ({ user, params }) => {
      const [row] = await db.select().from(cut).where(eq(cut.id, params.id));
      await ownedEdit(user, row);
      await db.delete(cut).where(eq(cut.id, params.id));
      return { ok: true };
    },
    { auth: true },
  )
  .post(
    "/clips/:id/overlays",
    async ({ user, params, body }) => {
      const { clip: c, duration } = await editableClip(user, params.id);
      validateRange(body.startSec, body.endSec, duration);
      const text = body.text.trim();
      if (!text) throw new HttpError(400, "Type some text first");
      const [row] = await db.insert(overlay).values({ clipId: c.id, ...body, text }).returning();
      return row!;
    },
    {
      auth: true,
      body: t.Object({
        ...range,
        text: t.String({ maxLength: 120 }),
        position: t.Union([t.Literal("top"), t.Literal("middle"), t.Literal("bottom")]),
      }),
    },
  )
  .delete(
    "/overlays/:id",
    async ({ user, params }) => {
      const [row] = await db.select().from(overlay).where(eq(overlay.id, params.id));
      await ownedEdit(user, row);
      await db.delete(overlay).where(eq(overlay.id, params.id));
      return { ok: true };
    },
    { auth: true },
  )
  .post(
    "/clips/:id/voiceovers",
    async ({ user, params, body }) => {
      const { clip: c, project: p, duration } = await editableClip(user, params.id);
      validateRange(body.startSec, body.endSec, duration);
      if (!body.contentType.startsWith("audio/")) throw new HttpError(400, "That recording isn't audio");
      const id = crypto.randomUUID();
      const key = voKey(p.id, id, body.contentType);
      const [row] = await db
        .insert(voiceover)
        .values({ id, clipId: c.id, startSec: body.startSec, endSec: body.endSec, objectKey: key, contentType: body.contentType })
        .returning();
      return { voiceover: row!, uploadUrl: await presignPut(key, body.contentType) };
    },
    { auth: true, body: t.Object({ ...range, contentType: t.String({ maxLength: 100 }) }) },
  )
  .post(
    "/voiceovers/:id/complete",
    async ({ user, params }) => {
      const [row] = await db.select().from(voiceover).where(eq(voiceover.id, params.id));
      await ownedEdit(user, row);
      const [updated] = await db.update(voiceover).set({ ready: true }).where(eq(voiceover.id, params.id)).returning();
      return updated!;
    },
    { auth: true },
  )
  .get(
    "/voiceovers/:id/url",
    async ({ user, params }) => {
      const [row] = await db.select().from(voiceover).where(eq(voiceover.id, params.id));
      if (!row) throw new HttpError(404, "Not found");
      await loadClip(user, row.clipId);
      return { url: await presignGet(row.objectKey) };
    },
    { auth: true },
  )
  .delete(
    "/voiceovers/:id",
    async ({ user, params }) => {
      const [row] = await db.select().from(voiceover).where(eq(voiceover.id, params.id));
      await ownedEdit(user, row);
      await db.delete(voiceover).where(eq(voiceover.id, params.id));
      return { ok: true };
    },
    { auth: true },
  );
