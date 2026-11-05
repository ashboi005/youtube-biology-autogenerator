import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyDir } from "./fs";

describe("emptyDir", () => {
  test("removes contents but keeps the directory itself (it may be a mount point)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "empty-"));
    await mkdir(join(dir, "job1"));
    await writeFile(join(dir, "job1", "clip.mov"), "x");
    await writeFile(join(dir, "stray.txt"), "x");
    await emptyDir(dir);
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  test("creates the directory if missing", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "empty-")), "work");
    await emptyDir(dir);
    expect(await readdir(dir)).toEqual([]);
  });
});
