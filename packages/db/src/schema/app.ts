import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  bigint,
} from "drizzle-orm/pg-core";

import { user } from "./auth";

export const projectStatus = pgEnum("project_status", [
  "draft",
  "queued",
  "rendering",
  "uploading",
  "done",
  "failed",
]);
export const privacy = pgEnum("privacy", ["private", "unlisted"]);
export const uploadState = pgEnum("upload_state", ["uploading", "ready", "failed"]);
export const overlayPosition = pgEnum("overlay_position", ["top", "middle", "bottom"]);

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

export const project = pgTable(
  "project",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    privacy: privacy("privacy").notNull().default("private"),
    status: projectStatus("status").notNull().default("draft"),
    progress: integer("progress").notNull().default(0),
    errorMessage: text("error_message"),
    thumbnailKey: text("thumbnail_key"),
    thumbnailPrompt: text("thumbnail_prompt"),
    youtubeVideoId: text("youtube_video_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    sentAt: timestamp("sent_at"),
  },
  (t) => [index("project_owner_idx").on(t.ownerId)],
);

export const clip = pgTable(
  "clip",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    objectKey: text("object_key").notNull(),
    uploadId: text("upload_id"),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    durationSec: doublePrecision("duration_sec"),
    width: integer("width"),
    height: integer("height"),
    rotation: integer("rotation"),
    isHdr: boolean("is_hdr").notNull().default(false),
    hasAudio: boolean("has_audio").notNull().default(true),
    uploadState: uploadState("upload_state").notNull().default("uploading"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("clip_project_idx").on(t.projectId)],
);

export const cut = pgTable(
  "cut",
  {
    id: id(),
    clipId: text("clip_id")
      .notNull()
      .references(() => clip.id, { onDelete: "cascade" }),
    startSec: real("start_sec").notNull(),
    endSec: real("end_sec").notNull(),
  },
  (t) => [index("cut_clip_idx").on(t.clipId)],
);

export const overlay = pgTable(
  "overlay",
  {
    id: id(),
    clipId: text("clip_id")
      .notNull()
      .references(() => clip.id, { onDelete: "cascade" }),
    startSec: real("start_sec").notNull(),
    endSec: real("end_sec").notNull(),
    text: text("text").notNull(),
    position: overlayPosition("position").notNull().default("bottom"),
  },
  (t) => [index("overlay_clip_idx").on(t.clipId)],
);

export const voiceover = pgTable(
  "voiceover",
  {
    id: id(),
    clipId: text("clip_id")
      .notNull()
      .references(() => clip.id, { onDelete: "cascade" }),
    startSec: real("start_sec").notNull(),
    endSec: real("end_sec").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    ready: boolean("ready").notNull().default(false),
  },
  (t) => [index("voiceover_clip_idx").on(t.clipId)],
);

/** Singleton row (id = "default"). */
export const youtubeConnection = pgTable("youtube_connection", {
  id: text("id").primaryKey().default("default"),
  channelId: text("channel_id").notNull(),
  channelTitle: text("channel_title").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  connectedAt: timestamp("connected_at").defaultNow().notNull(),
});

/** Singleton row (id = "default"). */
export const appSettings = pgTable("app_settings", {
  id: text("id").primaryKey().default("default"),
  introKey: text("intro_key"),
  outroKey: text("outro_key"),
  fadeSeconds: real("fade_seconds").notNull().default(1),
  audioCleanup: boolean("audio_cleanup").notNull().default(true),
  thumbnailPromptTemplate: text("thumbnail_prompt_template"),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
