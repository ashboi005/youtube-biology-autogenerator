import { api, putWithProgress } from "./api";
import type { Clip } from "./types";

const PART_SIZE = 10 * 1024 * 1024; // B2 minimum is 5 MB
const CONCURRENCY = 3;
const RETRIES = 4;

/** Local files by clip id, so the editor can preview from the phone without downloading. */
export const localFiles = new Map<string, File>();

type Created = { clip: Clip; key: string; uploadId: string };

/**
 * Multipart upload straight to B2. The server owns keys/uploadIds; we only ask it to sign parts.
 * Resumable: parts already on B2 are skipped.
 */
export async function uploadClip(
  projectId: string,
  file: File,
  onCreated: (clip: Clip) => void,
  onProgress: (fraction: number) => void,
): Promise<Clip> {
  const contentType = file.type || "video/quicktime";
  const { clip } = await api<Created>(`/projects/${projectId}/clips`, {
    body: { fileName: file.name || "clip.mov", contentType, sizeBytes: file.size },
  });
  localFiles.set(clip.id, file);
  onCreated(clip);
  return uploadParts(clip.id, file, onProgress);
}

export async function uploadParts(clipId: string, file: File, onProgress: (f: number) => void): Promise<Clip> {
  const total = Math.max(1, Math.ceil(file.size / PART_SIZE));
  const existing = await api<{ PartNumber: number; ETag: string; Size: number }[]>(`/clips/${clipId}/parts`).catch(
    () => [],
  );
  const done = new Map(existing.map((p) => [p.PartNumber, p.ETag]));
  const loaded = new Map<number, number>();
  for (const p of existing) loaded.set(p.PartNumber, p.Size);
  const report = () => onProgress(Math.min(0.99, [...loaded.values()].reduce((a, b) => a + b, 0) / file.size));
  report();

  const queue = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !done.has(n));

  const uploadOne = async (partNumber: number) => {
    const start = (partNumber - 1) * PART_SIZE;
    const blob = file.slice(start, Math.min(file.size, start + PART_SIZE));
    for (let attempt = 0; ; attempt++) {
      try {
        const { url } = await api<{ url: string }>(`/clips/${clipId}/sign-part`, { body: { partNumber } });
        const etag = await putWithProgress(url, blob, null, (l) => {
          loaded.set(partNumber, l);
          report();
        });
        done.set(partNumber, etag);
        loaded.set(partNumber, blob.size);
        report();
        return;
      } catch (err) {
        if (attempt >= RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  };

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) await uploadOne(n);
  });
  await Promise.all(workers);

  const parts = [...done.entries()].map(([PartNumber, ETag]) => ({ PartNumber, ETag }));
  const clip = await api<Clip>(`/clips/${clipId}/complete`, { body: { parts } });
  onProgress(1);
  return clip;
}
