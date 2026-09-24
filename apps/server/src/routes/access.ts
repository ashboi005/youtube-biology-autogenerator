export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Actor = { id: string; role?: string | null };

export const isAdmin = (u: Actor) => u.role === "admin";

export function canAccessProject(u: Actor, p: { ownerId: string }): boolean {
  return isAdmin(u) || p.ownerId === u.id;
}

const LOCKED = new Set(["queued", "rendering", "uploading"]);
export const isEditable = (status: string) => !LOCKED.has(status);

const MIN_RANGE = 0.1;
const END_TOLERANCE = 0.1;

export function validateRange(start: number, end: number, duration: number): void {
  if (!(start >= 0) || !(end <= duration + END_TOLERANCE) || !(end - start >= MIN_RANGE)) {
    throw new HttpError(400, "That start/end doesn't fit inside the clip");
  }
}

export function validateSendable(p: {
  title: string;
  clips: { uploadState: string }[];
  youtubeConnected: boolean;
  status: string;
}): string[] {
  const problems: string[] = [];
  if (!isEditable(p.status)) problems.push("This video is already being processed");
  if (!p.title.trim()) problems.push("Add a title");
  if (p.clips.length === 0) problems.push("Add at least one clip");
  else if (p.clips.some((c) => c.uploadState !== "ready")) problems.push("Wait for all clips to finish uploading");
  if (!p.youtubeConnected) problems.push("YouTube isn't connected yet (ask admin)");
  return problems;
}
