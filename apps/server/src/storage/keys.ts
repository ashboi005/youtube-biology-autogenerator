export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "bin";
  const ext = name
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return ext || "bin";
}

export const clipKey = (projectId: string, clipId: string, fileName: string) =>
  `uploads/${projectId}/clips/${clipId}.${extOf(fileName)}`;

export const voKey = (projectId: string, voiceoverId: string, contentType: string) =>
  `uploads/${projectId}/vo/${voiceoverId}.${contentType.startsWith("audio/webm") ? "webm" : "m4a"}`;

export const thumbKey = (projectId: string) => `uploads/${projectId}/thumb.jpg`;

export const assetKey = (kind: "intro" | "outro") => `assets/${kind}.mp4`;

/** True if `key` lives under this project's upload prefix (no traversal). */
export function isProjectKey(projectId: string, key: string): boolean {
  return key.startsWith(`uploads/${projectId}/`) && !key.split("/").includes("..");
}
