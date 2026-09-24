# YouTube Biology Autogenerator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone-first private dashboard where the creator uploads iPhone clips, orders/cuts/overlays/re-records them, fills title/description, gets an LLM thumbnail prompt, and sends a rendered video to YouTube as private.

**Architecture:** better-t-stack monorepo. Next.js (`apps/web`) is UI only; Elysia (`apps/server`) is the API (auth, CRUD, presign, LLM, YouTube OAuth, enqueue); a second entrypoint (`apps/server/src/worker.ts`) consumes pg-boss jobs one at a time and runs ffmpeg + YouTube upload. Video bytes go phone ⇄ B2 directly via presigned URLs; the worker streams B2 → local disk → ffmpeg → YouTube, then wipes disk.

**Tech Stack:** Bun 1.3, Elysia 1.4, Next.js 16, Drizzle 1.0-rc + Postgres, Better Auth 1.7 (admin plugin), pg-boss 12, @aws-sdk/client-s3 v3 (B2 S3 endpoint), googleapis, AI SDK 7 + merge-gateway-ai-sdk-provider, Uppy 6 (@uppy/aws-s3 multipart), ffmpeg/ffprobe.

**Spec:** `docs/superpowers/specs/2026-09-24-youtube-autogenerator-design.md`

## Global Constraints

- One render at a time (`pg-boss` work with batchSize 1, single worker process).
- ffmpeg: `nice -n 10`, `-threads 3`, `libx264 -preset veryfast -crf 20`, `aac 192k`, `-movflags +faststart`, output 1920×1080 @ 30 fps yuv420p.
- Audio cleanup: `highpass=f=80,afftdn=nr=10:nf=-40,loudnorm=I=-14:TP=-1.5:LRA=11`.
- `/work/<jobId>` always removed in `finally`; `/work` wiped on worker start; fail early if free disk < 3× inputs.
- B2 keys: `uploads/<projectId>/clips/<clipId>.<ext>`, `uploads/<projectId>/vo/<voiceoverId>.m4a`, `uploads/<projectId>/thumb.jpg`, `assets/intro.mp4`, `assets/outro.mp4`.
- Lifecycle on `uploads/`: hide after 15 days, delete 1 day after hide, cancel unfinished large files after 1 day. No delete button.
- All edits stored in **clip-source seconds**.
- Title ≤ 100 chars, description ≤ 5000 chars; YouTube upload always `categoryId=27`; privacy `private|unlisted`, default `private`.
- Thumbnail client-side resized to 1280×720 JPEG < 2 MB.
- LLM: `createMergeGateway({ apiKey: MERGE_GATEWAY_API_KEY })`, model from `MERGE_MODEL`; 30 s timeout; 10 calls/user/hour.
- Auth: `disableSignUp: true`, admin plugin roles `admin` / `editor`; editors see only their projects.
- Refresh token AES-256-GCM encrypted with `TOKEN_ENC_KEY` (32-byte hex).

## Review Focus

1. **Edits that overlap a cut or each other** (text 0:10–0:14 when 0:12–0:20 is cut; two overlapping cuts) — expected: cuts merge, overlays/voice clamp to kept time or drop if fully cut. Test in Task 3.
2. **Voiceover recorded longer or shorter than its range** — expected: trimmed/padded to exactly the range; never shifts later audio. Test in Task 4 (args) + Task 12 (integration).
3. **Clip with no audio track** (screen recordings, some imports) — expected: silent audio generated so concat/xfade don't fail. Test in Task 4 (`hasAudio=false` → `anullsrc`).
4. **Presign for a key outside the caller's project / someone else's project** — expected: 403. Test in Task 7.
5. **Text with quotes, colons, backslashes, `%`** in drawtext — expected: rendered literally, ffmpeg doesn't choke. Test in Task 4 (escape) + Task 12.

---

### Task 1: Scaffold + env + tooling  ✅ (scaffold done)

**Files:** repo root (scaffold), `apps/server/.env.schema`, `apps/server/package.json` scripts (`test`, `worker`, `seed:users`, `b2:setup`), `docker-compose.yml` (postgres service for dev).

- [x] Run the better-t-stack command, move into repo, commit spec.
- [ ] Add env vars to `apps/server/.env.schema` (B2_*, GOOGLE_*, TOKEN_ENC_KEY, MERGE_*, WORK_DIR, WEB_URL) with `@required=false` for the integration vars so dev boots without them; regenerate types (`bun run env:generate`).
- [ ] Add `postgres:17` service to docker-compose (volume, healthcheck) and wire `server` to it.
- [ ] Commit.

### Task 2: Database schema

**Files:** Create `packages/db/src/schema/app.ts`; Modify `packages/db/src/schema/index.ts`, `packages/db/src/relations.ts`, `packages/db/src/schema/auth.ts` (admin plugin columns: `role`, `banned`, `banReason`, `banExpires` on user; `impersonatedBy` on session).

**Produces:** tables `project`, `clip`, `cut`, `overlay`, `voiceover`, `youtubeConnection`, `appSettings` exactly as spec §5; enums `projectStatus`, `privacy`, `overlayPosition`, `uploadState`.

- [ ] Write schema; `bun run db:push` against local Postgres; verify with `\d project`.
- [ ] Commit.

### Task 3: `timeline/` (pure) — TDD

**Files:** Create `apps/server/src/timeline/index.ts`, test `apps/server/src/timeline/index.test.ts`.

**Produces:**
```ts
type Range = { start: number; end: number };
type ClipInput = { id: string; durationSec: number; hasAudio: boolean; isHdr: boolean;
  cuts: Range[]; overlays: (Range & { text: string; position: "top"|"middle"|"bottom" })[];
  voiceovers: (Range & { id: string })[] };
type PlannedClip = { id: string; keep: Range[]; outputOffset: number; outputDuration: number; hasAudio: boolean; isHdr: boolean };
type RenderPlan = { clips: PlannedClip[]; contentDuration: number;
  overlays: { start: number; end: number; text: string; position: ... }[];      // content-output time
  voiceovers: { id: string; start: number; end: number; srcOffset: number }[] }; // srcOffset = seconds into the VO file
function mergeRanges(r: Range[]): Range[];
function keepRanges(duration: number, cuts: Range[]): Range[];
function mapRange(keep: Range[], r: Range): Range[];   // source → clip-output ranges (may split/drop)
function buildPlan(clips: ClipInput[]): RenderPlan;
```

Tests: merge overlapping/adjacent/unsorted cuts; cuts clamped to [0,duration]; keep of no cuts = whole clip; mapRange across a cut splits into two; fully-cut overlay dropped; buildPlan offsets across 2 clips; voiceover partially cut → srcOffset advanced correctly; tiny keep segments < 0.05 s dropped.

- [ ] Write failing tests → run (`bun test src/timeline`) → implement → pass → commit.

### Task 4: `render/args` (pure) — TDD

**Files:** Create `apps/server/src/render/args.ts`, `apps/server/src/render/escape.ts`, tests alongside.

**Consumes:** `RenderPlan` (Task 3). **Produces:**
```ts
type RenderInputs = { plan: RenderPlan; clipPaths: Record<string,string>; voPaths: Record<string,string>;
  intro?: { path: string; duration: number; hasAudio: boolean }; outro?: {...}; fadeSeconds: number;
  fontPath: string; outPath: string; audioCleanup: boolean };
function buildFfmpegArgs(i: RenderInputs): { args: string[]; totalDuration: number };
function escapeDrawtext(s: string): string;
```
Filtergraph: per clip `trim/atrim` segments → concat → normalize (scale/pad/fps/format/setsar, `zscale+tonemap` if HDR) ; no-audio → `anullsrc` trimmed to duration; concat clips; voice ranges `volume=0:enable=…` on content audio + each VO `atrim=srcOffset:srcOffset+len,apad,atrim=0:len,adelay=start*1000|…` → `amix=normalize=0`; cleanup chain; drawtext per overlay (text written via `textfile=` to avoid escaping hell; `escapeDrawtext` used for fallback); intro/outro `xfade`+`acrossfade`. `totalDuration` = intro + content + outro − fades.

Tests: args contain `-threads 3`, `veryfast`, `crf 20`; one `drawtext` per overlay with correct `between(t,a,b)` (shifted by intro−fade); HDR clip gets tonemap; no-audio clip gets anullsrc; no intro → no xfade; totalDuration math; escape of `'`, `:`, `\`, `%`.

- [ ] TDD cycle → commit.

### Task 5: `render/run` + ffprobe

**Files:** Create `apps/server/src/render/run.ts`, `apps/server/src/render/probe.ts`; bundle font `apps/server/assets/Inter-Bold.ttf` (OFL).

**Produces:** `runFfmpeg(args, totalDuration, onProgress(pct)) : Promise<void>` (spawns `nice -n 10 ffmpeg -progress pipe:1 -nostats …`, parses `out_time_us`, keeps last 20 stderr lines for error), `probe(urlOrPath): Promise<{ durationSec, width, height, rotation, isHdr, hasAudio }>`.

- [ ] Test `probe` on a lavfi-generated file (`ffmpeg -f lavfi -i testsrc=d=2 …`) → commit.

### Task 6: `storage/` (B2)

**Files:** Create `apps/server/src/storage/index.ts`, `apps/server/scripts/b2-setup.ts`.

**Produces:** `createMultipart(key, contentType)`, `signPart(key, uploadId, partNumber)`, `listParts`, `completeMultipart(key, uploadId, parts)`, `abortMultipart`, `presignGet(key, seconds=3600)`, `presignPut(key, contentType)`, `downloadToFile(key, path)` (streams), `putObject(key, body, contentType)`, key builders `clipKey/voKey/thumbKey`. Setup script: `PutBucketCors` (origin WEB_URL, PUT/GET/HEAD, expose ETag) via S3 API + lifecycle via B2 native `b2_authorize_account` → `b2_update_bucket`.

- [ ] Implement; key builder unit test; commit.

### Task 7: Auth hardening + API routes

**Files:** Modify `packages/auth/src/index.ts` (disableSignUp, admin plugin, rate limit); Create `apps/server/src/routes/{guard,projects,clips,edits,uploads,settings,youtube}.ts`, `apps/server/src/app.ts` (Elysia app, exported type for Eden), Modify `apps/server/src/index.ts`; `apps/server/scripts/seed-users.ts`.

**Produces:** REST under `/api`:
- `GET/POST /projects`, `GET/PATCH /projects/:id` (title, description, privacy), `POST /projects/:id/send`, `POST /projects/:id/thumbnail-prompt`
- `POST /projects/:id/clips` (create row + multipart), `PATCH /projects/:id/clips/order`, `DELETE /clips/:id`, `POST /clips/:id/complete` (complete multipart + probe), `GET /clips/:id/url`
- `POST /uploads/sign-part`, `POST /uploads/abort`, `POST /uploads/list-parts`
- `POST/DELETE /clips/:id/cuts|overlays` , `POST /clips/:id/voiceovers` (returns presigned PUT), `DELETE /voiceovers/:id`
- `POST /projects/:id/thumbnail` (presigned PUT for thumb), `GET /projects/:id/thumbnail-url`
- admin: `GET/PATCH /settings`, `POST /settings/intro|outro` (presigned PUT), `GET /youtube/status`, `GET /youtube/connect`, `GET /youtube/callback`
Ownership helper `assertProjectAccess(user, projectId)`; upload endpoints validate key prefix belongs to project → 403 otherwise (Review Focus 4 test).

- [ ] Implement guard + ownership test (bun test with in-memory fake loader); routes; seed script; commit.

### Task 8: `llm/` thumbnail prompt — TDD

**Files:** Create `apps/server/src/llm/index.ts`, test.

**Produces:** `generateThumbnailPrompt({ title, description, template }, model = defaultModel()) : Promise<string>`; `DEFAULT_THUMBNAIL_TEMPLATE`. Uses `generateText` with `abortSignal: AbortSignal.timeout(30_000)`. Test with `MockLanguageModel` from `ai/test`. In-memory rate limiter `checkRate(userId)` 10/h tested.

- [ ] TDD → commit.

### Task 9: `youtube/`

**Files:** Create `apps/server/src/youtube/{crypto,client}.ts`, test for crypto round-trip.

**Produces:** `encrypt(text)/decrypt(text)`; `authUrl(state)`, `exchangeCode(code) → {refreshToken, channelId, channelTitle}`, `uploadVideo({ filePath, title, description, privacy, onProgress }) → videoId` (resumable via googleapis `videos.insert` with `media.body` stream, `onUploadProgress`), `setThumbnail(videoId, filePath)`. Error mapping: `invalid_grant` → `YOUTUBE_RECONNECT`, `quotaExceeded` → `YOUTUBE_QUOTA`.

- [ ] Crypto test → implement → commit.

### Task 10: Worker job

**Files:** Create `apps/server/src/jobs/render-and-upload.ts`, `apps/server/src/jobs/queue.ts`, `apps/server/src/worker.ts`.

**Produces:** `queue.enqueueRender(projectId)`; job: disk check (`statfs`) → download → probe intro/outro → buildPlan → buildFfmpegArgs → runFfmpeg (progress 0–80) → uploadVideo with 3 retries (80–100) → setThumbnail → status `done` + `youtubeVideoId`; catch → `failed` + friendly message; `finally` rm -rf. Worker startup wipes `WORK_DIR`. Queue options: `retryLimit: 1`, `expireInSeconds: 3600`.

- [ ] Implement with dependency injection (`deps` object: storage, youtube, db) so Task 12 can stub → commit.

### Task 11: Web UI

**Files (apps/web/src):** `lib/api.ts` (Eden treaty client with credentials), `app/page.tsx` (redirect), `app/login/page.tsx` (sign-in only; delete sign-up form), `app/projects/page.tsx` (list + New), `app/projects/[id]/page.tsx` (5 step cards), `components/steps/{clips-step,edit-step,details-step,thumbnail-step,send-step}.tsx`, `components/editor/{player,scrubber,edit-list,recorder}.tsx`, `components/uploader.ts` (Uppy headless), `lib/image.ts` (thumbnail resize), `app/settings/page.tsx` (admin), `components/header.tsx` (simplified).

- [ ] Build each step; big touch targets (min 48 px), single-column, mobile first.
- [ ] Editor preview: skip cut ranges on `timeupdate`, HTML text overlay, mute + play VO `<audio>` in voice ranges; local `File` object URL cache keyed by clipId, else presigned GET.
- [ ] Recorder: `MediaRecorder` (`audio/mp4` on Safari, fallback `audio/webm`), 3-2-1 countdown, plays video muted from start, upload blob to presigned PUT.
- [ ] Send step polls `GET /projects/:id` every 3 s while queued/rendering/uploading.
- [ ] `bun run check-types` → commit.

### Task 12: Integration test + Docker

**Files:** `apps/server/src/jobs/render-and-upload.test.ts`, `apps/server/Dockerfile` (ffmpeg static w/ zimg), `docker-compose.yml` (worker service with `cpus: 3`, `mem_limit: 3g`, `/work` volume; postgres), `README.md` (setup: Google Cloud, B2, seed, deploy).

- [ ] Integration: generate 2 lavfi clips (one without audio) + intro + a VO wav; run job with stubbed storage (copy files) and stubbed YouTube (records call); assert output 1920×1080, 30 fps, duration ≈ expected ± 0.2 s, drawtext with `'`/`:` text succeeded, work dir removed.
- [ ] Commit.
