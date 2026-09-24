import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resumableUpload } from "./resumable";

type Call = { method: string; url: string; headers: Record<string, string>; bodySize: number };

async function file(size: number) {
  const p = join(await mkdtemp(join(tmpdir(), "ru-")), "v.mp4");
  await writeFile(p, Buffer.alloc(size, 1));
  return p;
}

function fakeYoutube(script: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = init.body as Blob | string | undefined;
    const call: Call = {
      method: init.method ?? "GET",
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      bodySize: body instanceof Blob ? body.size : typeof body === "string" ? body.length : 0,
    };
    calls.push(call);
    return script(call, calls.length);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const CHUNK = 256 * 1024;

describe("resumableUpload", () => {
  test("starts a session, uploads in chunks, returns the video id", async () => {
    const path = await file(CHUNK * 2 + 10);
    let received = 0;
    const { calls, fetchFn } = fakeYoutube((c) => {
      if (c.method === "POST") return new Response(null, { status: 200, headers: { Location: "https://up/session" } });
      received += c.bodySize;
      return received < CHUNK * 2 + 10
        ? new Response(null, { status: 308, headers: { Range: `bytes=0-${received - 1}` } })
        : Response.json({ id: "vid1" });
    });
    const progress: number[] = [];
    const id = await resumableUpload({
      accessToken: "tok", filePath: path, metadata: { snippet: {} }, chunkSize: CHUNK, fetchFn, onProgress: (f) => progress.push(f), sleep: async () => {},
    });
    expect(id).toBe("vid1");
    expect(calls[0]!.url).toContain("uploadType=resumable");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(calls.slice(1).map((c) => c.headers["content-range"])).toEqual([
      `bytes 0-${CHUNK - 1}/${CHUNK * 2 + 10}`,
      `bytes ${CHUNK}-${CHUNK * 2 - 1}/${CHUNK * 2 + 10}`,
      `bytes ${CHUNK * 2}-${CHUNK * 2 + 9}/${CHUNK * 2 + 10}`,
    ]);
    expect(progress.at(-1)).toBe(1);
  });

  test("after a network error, asks where to resume and continues from there", async () => {
    const path = await file(CHUNK * 2);
    let failedOnce = false;
    const { calls, fetchFn } = fakeYoutube((c) => {
      if (c.method === "POST") return new Response(null, { status: 200, headers: { Location: "https://up/s" } });
      if (c.headers["content-range"] === `bytes */${CHUNK * 2}`) {
        return new Response(null, { status: 308, headers: { Range: `bytes=0-${CHUNK - 1}` } });
      }
      if (c.headers["content-range"]?.startsWith(`bytes ${CHUNK}-`) && !failedOnce) {
        failedOnce = true;
        throw new TypeError("network down");
      }
      if (c.headers["content-range"]?.startsWith("bytes 0-")) {
        return new Response(null, { status: 308, headers: { Range: `bytes=0-${CHUNK - 1}` } });
      }
      return Response.json({ id: "vid2" });
    });
    const id = await resumableUpload({
      accessToken: "t", filePath: path, metadata: {}, chunkSize: CHUNK, fetchFn, onProgress: () => {}, sleep: async () => {},
    });
    expect(id).toBe("vid2");
    const ranges = calls.map((c) => c.headers["content-range"]).filter(Boolean);
    expect(ranges).toEqual([
      `bytes 0-${CHUNK - 1}/${CHUNK * 2}`,
      `bytes ${CHUNK}-${CHUNK * 2 - 1}/${CHUNK * 2}`,
      `bytes */${CHUNK * 2}`,
      `bytes ${CHUNK}-${CHUNK * 2 - 1}/${CHUNK * 2}`,
    ]);
  });

  test("a 4xx on session start is a permanent error (not retried)", async () => {
    const path = await file(10);
    const { calls, fetchFn } = fakeYoutube(() =>
      Response.json({ error: { code: 400, errors: [{ reason: "invalidTitle" }], message: "Bad title" } }, { status: 400 }),
    );
    const err = await resumableUpload({
      accessToken: "t", filePath: path, metadata: {}, chunkSize: CHUNK, fetchFn, onProgress: () => {}, sleep: async () => {},
    }).catch((e) => e);
    expect(err.code).toBe("YOUTUBE_INVALID");
    expect(calls).toHaveLength(1);
  });

  test("quota errors map to YOUTUBE_QUOTA", async () => {
    const path = await file(10);
    const { fetchFn } = fakeYoutube(() =>
      Response.json({ error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }, { status: 403 }),
    );
    const err = await resumableUpload({
      accessToken: "t", filePath: path, metadata: {}, chunkSize: CHUNK, fetchFn, onProgress: () => {}, sleep: async () => {},
    }).catch((e) => e);
    expect(err.code).toBe("YOUTUBE_QUOTA");
  });
});
