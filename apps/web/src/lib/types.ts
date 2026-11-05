export type ProjectStatus = "draft" | "queued" | "rendering" | "uploading" | "done" | "failed";
export type Position = "top" | "middle" | "bottom";

export type Project = {
  id: string;
  title: string;
  description: string;
  privacy: "private" | "unlisted";
  status: ProjectStatus;
  progress: number;
  errorMessage: string | null;
  thumbnailKey: string | null;
  thumbnailPrompt: string | null;
  youtubeVideoId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Cut = { id: string; clipId: string; startSec: number; endSec: number };
export type Overlay = Cut & { text: string; position: Position };
export type Voiceover = Cut & { objectKey: string; contentType: string; ready: boolean };

export type Clip = {
  id: string;
  projectId: string;
  position: number;
  originalName: string;
  sizeBytes: number;
  durationSec: number | null;
  isHdr: boolean;
  hasAudio: boolean;
  uploadState: "uploading" | "ready" | "failed";
  cuts: Cut[];
  overlays: Overlay[];
  voiceovers: Voiceover[];
};

export type ProjectDetail = {
  project: Project;
  clips: Clip[];
  youtubeConnected: boolean;
  problems: string[];
};

export type Me = { id: string; name: string; email: string; role: "admin" | "editor"; youtubeNeedsReconnect: boolean };

export const isBusy = (s: ProjectStatus) => s === "queued" || s === "rendering" || s === "uploading";

export function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}
