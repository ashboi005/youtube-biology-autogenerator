import { createHmac, timingSafeEqual } from "node:crypto";

import { appSettings, youtubeConnection } from "@youtube-biology-autogenerator/db/schema/index";
import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { ENV } from "../env.server";
import { DEFAULT_THUMBNAIL_TEMPLATE } from "../llm";
import { probe } from "../render/probe";
import { db } from "../services";
import { assetKey, headExists, presignGet, presignPut } from "../storage";
import { authUrl, exchangeCode } from "../youtube/client";
import { encrypt } from "../youtube/crypto";
import { HttpError } from "./access";
import { authContext } from "./context";
import { getSettings, getYoutubeConnection } from "./repo";

const bumperKind = t.Union([t.Literal("intro"), t.Literal("outro")]);

/** OAuth `state` = userId.timestamp.hmac — lets the callback verify without a session. */
function signState(userId: string) {
  const payload = `${userId}.${Date.now()}`;
  const mac = createHmac("sha256", ENV.BETTER_AUTH_SECRET).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function verifyState(state: string): boolean {
  const [userId, ts, mac] = state.split(".");
  if (!userId || !ts || !mac) return false;
  const expected = createHmac("sha256", ENV.BETTER_AUTH_SECRET).update(`${userId}.${ts}`).digest("base64url");
  const fresh = Date.now() - Number(ts) < 10 * 60 * 1000;
  return fresh && expected.length === mac.length && timingSafeEqual(Buffer.from(expected), Buffer.from(mac));
}

export const settingsRoutes = new Elysia()
  .use(authContext)
  .get(
    "/settings",
    async () => {
      const [s, yt] = await Promise.all([getSettings(), getYoutubeConnection()]);
      return {
        ...s,
        thumbnailPromptTemplate: s.thumbnailPromptTemplate ?? DEFAULT_THUMBNAIL_TEMPLATE,
        introUrl: s.introKey ? await presignGet(s.introKey) : null,
        outroUrl: s.outroKey ? await presignGet(s.outroKey) : null,
        youtube: yt
          ? { channelTitle: yt.channelTitle, connectedAt: yt.connectedAt, needsReconnect: yt.needsReconnect }
          : null,
      };
    },
    { admin: true },
  )
  .patch(
    "/settings",
    async ({ body }) => {
      await getSettings();
      const [s] = await db.update(appSettings).set(body).where(eq(appSettings.id, "default")).returning();
      return s!;
    },
    {
      admin: true,
      body: t.Object({
        fadeSeconds: t.Optional(t.Number({ minimum: 0.2, maximum: 3 })),
        audioCleanup: t.Optional(t.Boolean()),
        thumbnailPromptTemplate: t.Optional(t.String({ maxLength: 10000 })),
      }),
    },
  )
  .post(
    "/settings/bumper",
    async ({ body }) => ({ uploadUrl: await presignPut(assetKey(body.kind), "video/mp4") }),
    { admin: true, body: t.Object({ kind: bumperKind }) },
  )
  .post(
    "/settings/bumper/complete",
    async ({ body }) => {
      const key = assetKey(body.kind);
      if (!(await headExists(key))) throw new HttpError(400, "The upload didn't finish — try again");
      try {
        await probe(await presignGet(key, 600));
      } catch {
        throw new HttpError(400, "That file isn't a video we can read");
      }
      await getSettings();
      await db
        .update(appSettings)
        .set(body.kind === "intro" ? { introKey: key } : { outroKey: key })
        .where(eq(appSettings.id, "default"));
      return { ok: true };
    },
    { admin: true, body: t.Object({ kind: bumperKind }) },
  )
  .delete(
    "/settings/bumper/:kind",
    async ({ params }) => {
      if (params.kind !== "intro" && params.kind !== "outro") throw new HttpError(400, "Unknown kind");
      await getSettings();
      await db
        .update(appSettings)
        .set(params.kind === "intro" ? { introKey: null } : { outroKey: null })
        .where(eq(appSettings.id, "default"));
      return { ok: true };
    },
    { admin: true },
  )
  .get("/youtube/connect", ({ user }) => ({ url: authUrl(signState(user.id)) }), { admin: true })
  .delete(
    "/youtube",
    async () => {
      await db.delete(youtubeConnection).where(eq(youtubeConnection.id, "default"));
      return { ok: true };
    },
    { admin: true },
  )
  // Google redirects the browser here; no session needed — `state` is HMAC-verified.
  .get(
    "/youtube/callback",
    async ({ query, redirect }) => {
      const back = (status: string) => redirect(`${ENV.WEB_URL}/settings?youtube=${status}`);
      if (!query.state || !verifyState(query.state) || !query.code) return back("error");
      if (!ENV.TOKEN_ENC_KEY) throw new Error("TOKEN_ENC_KEY missing");
      try {
        const { refreshToken, channelId, channelTitle } = await exchangeCode(query.code);
        const values = {
          channelId,
          channelTitle,
          refreshTokenEnc: encrypt(refreshToken, ENV.TOKEN_ENC_KEY),
          needsReconnect: false,
        };
        await db
          .insert(youtubeConnection)
          .values({ id: "default", ...values })
          .onConflictDoUpdate({ target: youtubeConnection.id, set: { ...values, connectedAt: new Date() } });
        return back("connected");
      } catch (err) {
        console.error("[youtube oauth]", err);
        return back("error");
      }
    },
    { query: t.Object({ code: t.Optional(t.String()), state: t.Optional(t.String()), error: t.Optional(t.String()) }) },
  );
