import { afterAll, describe, expect, test } from "bun:test";

import { project, user } from "@youtube-biology-autogenerator/db/schema/index";
import { eq } from "drizzle-orm";

import { db } from "../services";
import { claimForSend } from "./repo";

// Uses the local dev Postgres (DATABASE_URL).
const uid = `test-${crypto.randomUUID()}`;

afterAll(async () => {
  await db.delete(user).where(eq(user.id, uid));
});

describe("claimForSend", () => {
  test("two concurrent sends: exactly one wins", async () => {
    await db.insert(user).values({ id: uid, name: "t", email: `${uid}@test.local` });
    const [p] = await db.insert(project).values({ ownerId: uid, title: "x" }).returning();
    const results = await Promise.all([claimForSend(p!.id), claimForSend(p!.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const [row] = await db.select().from(project).where(eq(project.id, p!.id));
    expect(row!.status).toBe("queued");
  });

  test("a busy project cannot be claimed; a done one can be re-sent", async () => {
    const [p] = await db.insert(project).values({ ownerId: uid, title: "y", status: "rendering" }).returning();
    expect(await claimForSend(p!.id)).toBeNull();
    await db.update(project).set({ status: "done" }).where(eq(project.id, p!.id));
    expect(await claimForSend(p!.id)).not.toBeNull();
  });
});
