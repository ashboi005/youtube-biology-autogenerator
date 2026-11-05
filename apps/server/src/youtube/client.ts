import { createReadStream } from "node:fs";

import { google } from "googleapis";

import { ENV } from "../env.server";
import { YoutubeError } from "./errors";
import { resumableUpload } from "./resumable";

export { YoutubeError } from "./errors";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

function oauthClient() {
  if (!ENV.GOOGLE_CLIENT_ID || !ENV.GOOGLE_CLIENT_SECRET || !ENV.GOOGLE_REDIRECT_URI) {
    throw new Error("YouTube is not configured (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI missing)");
  }
  return new google.auth.OAuth2(ENV.GOOGLE_CLIENT_ID, ENV.GOOGLE_CLIENT_SECRET, ENV.GOOGLE_REDIRECT_URI);
}

export function authUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // always return a refresh token
    scope: SCOPES,
    state,
  });
}

export async function exchangeCode(code: string) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error("Google did not return a refresh token — try connecting again");
  client.setCredentials(tokens);
  const yt = google.youtube({ version: "v3", auth: client });
  const res = await yt.channels.list({ part: ["snippet"], mine: true });
  const channel = res.data.items?.[0];
  if (!channel?.id) throw new Error("This Google account has no YouTube channel");
  return {
    refreshToken: tokens.refresh_token,
    channelId: channel.id,
    channelTitle: channel.snippet?.title ?? "YouTube channel",
  };
}

/** Map Google API errors to codes the UI can explain in plain English. */
export function toYoutubeError(err: unknown): YoutubeError {
  if (err instanceof YoutubeError) return err;
  const e = err as {
    message?: string;
    status?: number;
    response?: { status?: number; data?: { error?: string | { errors?: { reason?: string }[] } } };
  };
  const data = e.response?.data?.error;
  if (data === "invalid_grant" || e.message?.includes("invalid_grant")) {
    return new YoutubeError("YOUTUBE_RECONNECT", "YouTube needs reconnecting (ask admin)");
  }
  const reasons = typeof data === "object" ? (data.errors ?? []).map((x) => x.reason) : [];
  if (reasons.some((r) => r === "quotaExceeded" || r === "uploadLimitExceeded")) {
    return new YoutubeError("YOUTUBE_QUOTA", "YouTube's daily limit reached — try again tomorrow");
  }
  const status = e.response?.status ?? e.status;
  if (status && status >= 400 && status < 500) {
    return new YoutubeError("YOUTUBE_INVALID", `YouTube rejected this: ${e.message ?? status}`);
  }
  return new YoutubeError("YOUTUBE_OTHER", `YouTube upload failed: ${e.message ?? "unknown error"}`);
}

export type UploadInput = {
  refreshToken: string;
  filePath: string;
  title: string;
  description: string;
  privacy: "private" | "unlisted";
  onProgress: (fraction: number) => void;
};

export async function uploadVideo(input: UploadInput): Promise<string> {
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: input.refreshToken });
  let accessToken: string | null | undefined;
  try {
    accessToken = (await auth.getAccessToken()).token;
  } catch (err) {
    throw toYoutubeError(err);
  }
  if (!accessToken) throw new YoutubeError("YOUTUBE_RECONNECT", "YouTube needs reconnecting (ask admin)");
  return resumableUpload({
    accessToken,
    filePath: input.filePath,
    metadata: {
      snippet: { title: input.title, description: input.description, categoryId: "27" },
      status: { privacyStatus: input.privacy, selfDeclaredMadeForKids: false },
    },
    onProgress: input.onProgress,
  });
}

export async function setThumbnail(refreshToken: string, videoId: string, filePath: string): Promise<void> {
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refreshToken });
  const yt = google.youtube({ version: "v3", auth });
  try {
    await yt.thumbnails.set({ videoId, media: { mimeType: "image/jpeg", body: createReadStream(filePath) } });
  } catch (err) {
    throw toYoutubeError(err);
  }
}
