import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Delete everything inside `dir` but not `dir` itself — in Docker it's a mounted volume (rm → EBUSY). */
export async function emptyDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir)) {
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}
