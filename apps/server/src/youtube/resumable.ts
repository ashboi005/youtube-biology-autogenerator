import { YoutubeError } from "./errors";

const ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const DEFAULT_CHUNK = 64 * 1024 * 1024; // must be a multiple of 256 KiB
const MAX_RETRIES = 6;

type Opts = {
  accessToken: string;
  filePath: string;
  metadata: object;
  onProgress: (fraction: number) => void;
  chunkSize?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/** Turn a non-OK YouTube response into a coded error. */
export async function classify(res: Response): Promise<YoutubeError> {
  let reasons: string[] = [];
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
    reasons = (body.error?.errors ?? []).map((e) => e.reason ?? "");
    message = body.error?.message ?? message;
  } catch {
    /* not JSON */
  }
  if (reasons.some((r) => r === "quotaExceeded" || r === "uploadLimitExceeded" || r === "rateLimitExceeded")) {
    return new YoutubeError("YOUTUBE_QUOTA", "YouTube's daily limit reached — try again tomorrow");
  }
  if (res.status === 401) return new YoutubeError("YOUTUBE_RECONNECT", "YouTube needs reconnecting (ask admin)");
  if (res.status >= 400 && res.status < 500) {
    return new YoutubeError("YOUTUBE_INVALID", `YouTube rejected this video: ${message}`);
  }
  return new YoutubeError("YOUTUBE_OTHER", `YouTube had a problem (${res.status}) — tap Try again`);
}

const parseRangeEnd = (res: Response) => {
  const m = /bytes=0-(\d+)/.exec(res.headers.get("Range") ?? "");
  return m ? Number(m[1]) + 1 : 0;
};

/**
 * YouTube resumable upload: chunks are streamed from disk, and after any network/5xx failure
 * we ask the server how much it has and continue from there (no full re-upload).
 */
export async function resumableUpload(o: Opts): Promise<string> {
  const fetchFn = o.fetchFn ?? fetch;
  const sleep = o.sleep ?? ((ms) => Bun.sleep(ms));
  const chunk = o.chunkSize ?? DEFAULT_CHUNK;
  const file = Bun.file(o.filePath);
  const size = file.size;

  const start = await fetchFn(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${o.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size),
      "X-Upload-Content-Type": "video/mp4",
    },
    body: JSON.stringify(o.metadata),
  });
  if (!start.ok) throw await classify(start);
  const session = start.headers.get("Location");
  if (!session) throw new YoutubeError("YOUTUBE_OTHER", "YouTube didn't start the upload — tap Try again");

  const done = async (res: Response) => {
    o.onProgress(1);
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new YoutubeError("YOUTUBE_OTHER", "YouTube did not return a video id");
    return body.id;
  };

  /** Ask the server how many bytes it has. Returns an id if the upload is actually complete. */
  const query = async (): Promise<{ offset: number } | { id: string }> => {
    const res = await fetchFn(session, { method: "PUT", headers: { "Content-Range": `bytes */${size}` } });
    if (res.status === 200 || res.status === 201) return { id: await done(res) };
    if (res.status === 308) return { offset: parseRangeEnd(res) };
    if (res.status >= 500) throw new Error(`status ${res.status}`);
    throw await classify(res);
  };

  let offset = 0;
  let failures = 0;
  const backoff = async () => {
    if (++failures > MAX_RETRIES) {
      throw new YoutubeError("YOUTUBE_OTHER", "Lost connection to YouTube — tap Try again");
    }
    await sleep(Math.min(60_000, 2000 * 2 ** (failures - 1)));
  };

  while (true) {
    const end = Math.min(offset + chunk, size);
    let res: Response;
    try {
      res = await fetchFn(session, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${size}`, "Content-Length": String(end - offset) },
        body: file.slice(offset, end),
      });
    } catch (err) {
      if (err instanceof YoutubeError) throw err;
      await backoff();
      const q = await query().catch(() => ({ offset }));
      if ("id" in q) return q.id;
      offset = q.offset;
      continue;
    }

    if (res.status === 200 || res.status === 201) return done(res);
    if (res.status === 308) {
      offset = parseRangeEnd(res);
      failures = 0;
      o.onProgress(offset / size);
      continue;
    }
    if (res.status >= 500) {
      await backoff();
      const q = await query().catch(() => ({ offset }));
      if ("id" in q) return q.id;
      offset = q.offset;
      continue;
    }
    throw await classify(res);
  }
}
