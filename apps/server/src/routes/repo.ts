import {
  appSettings,
  clip,
  cut,
  overlay,
  project,
  voiceover,
  youtubeConnection,
} from "@youtube-biology-autogenerator/db/schema/index";
import { asc, eq, inArray } from "drizzle-orm";

import { db } from "../services";
import { type Actor, canAccessProject, HttpError, isEditable } from "./access";

export type Project = typeof project.$inferSelect;
export type Clip = typeof clip.$inferSelect;

export async function getSettings() {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, "default"));
  if (row) return row;
  const [created] = await db.insert(appSettings).values({ id: "default" }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(appSettings).where(eq(appSettings.id, "default")))[0]!;
}

export async function getYoutubeConnection() {
  const [row] = await db.select().from(youtubeConnection).where(eq(youtubeConnection.id, "default"));
  return row ?? null;
}

export async function loadProject(user: Actor, id: string): Promise<Project> {
  const [p] = await db.select().from(project).where(eq(project.id, id));
  if (!p || !canAccessProject(user, p)) throw new HttpError(404, "Video not found");
  return p;
}

export async function loadEditableProject(user: Actor, id: string): Promise<Project> {
  const p = await loadProject(user, id);
  if (!isEditable(p.status)) throw new HttpError(409, "This video is being processed — wait until it's done");
  return p;
}

export async function loadClip(user: Actor, clipId: string, editable = false) {
  const [c] = await db.select().from(clip).where(eq(clip.id, clipId));
  if (!c) throw new HttpError(404, "Clip not found");
  const p = editable ? await loadEditableProject(user, c.projectId) : await loadProject(user, c.projectId);
  return { clip: c, project: p };
}

export async function listClips(projectId: string) {
  return db.select().from(clip).where(eq(clip.projectId, projectId)).orderBy(asc(clip.position));
}

/** Clips with their edits, in playback order. */
export async function loadTimeline(projectId: string) {
  const clips = await listClips(projectId);
  const ids = clips.map((c) => c.id);
  if (!ids.length) return [];
  const [cuts, overlays, voiceovers] = await Promise.all([
    db.select().from(cut).where(inArray(cut.clipId, ids)).orderBy(asc(cut.startSec)),
    db.select().from(overlay).where(inArray(overlay.clipId, ids)).orderBy(asc(overlay.startSec)),
    db.select().from(voiceover).where(inArray(voiceover.clipId, ids)).orderBy(asc(voiceover.startSec)),
  ]);
  return clips.map((c) => ({
    ...c,
    cuts: cuts.filter((x) => x.clipId === c.id),
    overlays: overlays.filter((x) => x.clipId === c.id),
    voiceovers: voiceovers.filter((x) => x.clipId === c.id),
  }));
}
