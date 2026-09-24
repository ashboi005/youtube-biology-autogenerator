# YouTube Biology Autogenerator — Design

**Date:** 2026-09-24
**Status:** Draft for review

## 1. Goal

A private, phone-first web dashboard that lets one non-technical creator (records biology tutorials on an iPhone on a tripod, ≤15 min per video) go from raw clips to a **private YouTube upload** without anyone else editing or uploading for her.

**Success criteria**

- She can do the whole flow from iPhone Safari: upload clips → order → cut → text → re-record bad sections → title/description → thumbnail → "Send to YouTube".
- Every video gets the channel intro (fade out into the content) automatically, and an optional outro.
- The server stays light (4 vCPU / 8 GB RAM / limited disk): one render at a time, no full videos in memory, local files deleted as soon as a job ends.
- Running cost is effectively **$0/month** at normal volume.
- Nobody outside the two seeded accounts can reach anything.

## 2. Users & roles

| Role | Who | Can do |
|---|---|---|
| `admin` | the developer | everything + connect YouTube, upload intro/outro, edit thumbnail prompt template, manage users |
| `editor` | the creator | create/edit her projects, send to YouTube |

No self-signup. Accounts are created by a seed script.

## 3. User flow

A project is one video. The project page is a vertical list of 5 steps, each a big tappable card showing ✓ when done:

1. **Clips** — "Add clips" opens the iOS picker (multiple select). Each clip shows a thumbnail, duration, and an upload progress bar. Drag handles or ↑/↓ buttons change the order. Tap 🗑 to remove.
2. **Edit** — pick a clip (chips across the top), then the video player plus three big buttons:
   - **✂️ Cut a part**: tap "Start here" at the playhead, scrub, tap "End here". The removed range shows as a red block on the scrubber.
   - **🔤 Add text**: type text, pick **Top / Middle / Bottom**, and it shows from the playhead for 4 s (tap "End here" to change the end). One fixed style: white bold text on a semi-transparent dark box.
   - **🎙 Re-record voice**: scrub to the bad part and tap "Record from here". A 3-2-1 countdown plays, then the video plays **muted** while she talks. She taps Stop, and the new audio replaces the original for that range. She can tap ▶ to hear it back, or 🗑 to delete it.
   - Below the buttons is a list of all edits on this clip ("Cut 1:02–1:15", "Text 'Mitosis' 0:10–0:14", "Voice 2:30–2:41"), each with 🗑.
   - **Preview** is the real `<video>` element playing the original clip. During playback, cut ranges are skipped, text is drawn as an HTML overlay, and voice ranges mute the video while the recorded audio plays. It's a preview only; the server does the real render.
3. **Details** — plain **Title** and **Description** text fields (title limited to 100 chars, description to 5000, same as YouTube). There's also a privacy toggle: **Private / Unlisted** (default Private).
4. **Thumbnail** — "✨ Make thumbnail prompt" is enabled once Title and Description are filled. The LLM (through Merge) returns a prompt, which appears in a read-only box with a big **Copy** button and a link that opens ChatGPT. She generates the image there, saves it, then taps "Upload thumbnail". The image is resized and compressed in the browser to 1280×720 JPEG under 2 MB (YouTube's limit).
5. **Send to YouTube** — shows a checklist of what's done or missing. Tapping **Send** changes the status to *Queued → Rendering 43% → Uploading to YouTube 70% → Done* with a "Open in YouTube Studio" link. If it fails, she sees a plain-English error and a **Try again** button.

Home screen: a list of projects (title, status badge, date) and a big "New video" button.

## 4. Architecture

Scaffold: `better-t-stack` (Next.js web, Elysia server on Bun, Drizzle + Postgres, Better Auth, Docker deploy).

```
iPhone Safari ──HTTPS──► Next.js (apps/web) ──fetch──► Elysia API (apps/server)
     │                                                     │    │
     │ presigned multipart PUT / GET (direct, no proxy)    │    ├── Postgres (Drizzle; pg-boss queue tables)
     ▼                                                     │    └── Merge Gateway (LLM)
 Backblaze B2 bucket ◄────── stream download ─── Worker (apps/server, 2nd entrypoint)
                                                   │  ffprobe / ffmpeg (nice, 3 threads)
                                                   └──► YouTube Data API v3 (resumable upload + thumbnails.set)
```

- **Next.js (`apps/web`)**: UI only. Uses the Better Auth client and typed calls to Elysia (Eden treaty).
- **Elysia API (`apps/server`)**: auth, CRUD, B2 presigning, the LLM endpoint, YouTube OAuth, and adding jobs to the queue. It never handles video bytes.
- **Worker (`apps/server/src/worker.ts`)**: a separate process, running as a separate container from the same image. It consumes **pg-boss** jobs with **concurrency 1**, so the queue lives in Postgres and Redis isn't needed.
- **Postgres**: app data, Better Auth tables, pg-boss tables.
- **Backblaze B2**: through its S3-compatible API using `@aws-sdk/client-s3` pointed at the B2 endpoint. No AWS account is involved.

### Module boundaries (server)

| Module | Responsibility | Depends on |
|---|---|---|
| `storage/` | presign multipart create/sign/complete/abort, presign GET, stream-download to a path, put small objects | S3 client |
| `timeline/` | **pure** functions: keep-ranges from cuts, source→output time mapping, build the render plan from DB rows | nothing |
| `render/` | turn a render plan into ffmpeg args (pure), run ffmpeg with progress callback, run ffprobe | `timeline`, ffmpeg binary |
| `youtube/` | OAuth URL/callback, token refresh, resumable upload with progress, `thumbnails.set` | googleapis |
| `llm/` | `generateThumbnailPrompt({ title, description, template })` | Merge Gateway provider |
| `jobs/` | the `render-and-upload` job: orchestrates the above, status updates, cleanup | all of the above |
| `routes/` | Elysia route handlers, auth guards, input validation | modules above |

`timeline/` and the ffmpeg arg builder are pure, so most of the logic can be unit-tested without ffmpeg or network access.

## 5. Data model (Drizzle)

Better Auth tables (`user`, `session`, `account`, `verification`) come with the admin plugin's `role` column.

```
project
  id, ownerId → user, title, description, privacy ('private'|'unlisted'),
  status ('draft'|'queued'|'rendering'|'uploading'|'done'|'failed'),
  progress (0-100), errorMessage, thumbnailKey, thumbnailPrompt,
  youtubeVideoId, createdAt, updatedAt, sentAt

clip
  id, projectId, position (int), objectKey, originalName, sizeBytes,
  durationSec, width, height, rotation, isHdr (bool),
  uploadState ('uploading'|'ready'|'failed'), createdAt

cut        id, clipId, startSec, endSec                 -- clip-source time
overlay    id, clipId, startSec, endSec, text, position ('top'|'middle'|'bottom')
voiceover  id, clipId, startSec, endSec, objectKey, durationSec

youtube_connection   (singleton)
  id, channelId, channelTitle, refreshTokenEnc, connectedAt

app_settings         (singleton)
  introKey, outroKey (nullable), fadeSeconds (default 1.0),
  thumbnailPromptTemplate (text, placeholder default), llmModel (default via env)
```

**All edits are stored in clip-source time.** Cuts, overlays and voiceovers are tied to the clip they belong to, so reordering clips or adding a cut never moves a text overlay onto the wrong frame. The output time is calculated only at render time by `timeline/`.

## 6. Storage (Backblaze B2)

- One **private** bucket. Keys:
  - `uploads/<projectId>/clips/<clipId>.<ext>`
  - `uploads/<projectId>/vo/<voiceoverId>.m4a`
  - `uploads/<projectId>/thumb.jpg`
  - `assets/intro.mp4`, `assets/outro.mp4` (kept permanently)
- **Upload**: Uppy `@uppy/aws-s3` in multipart mode with 10 MB parts (the B2 minimum is 5 MB). The server signs each part. Uploads resume if mobile data drops.
- **Retention (the cost model)**: a lifecycle rule on `uploads/` hides files after **15 days** and deletes them 1 day later. Unfinished multipart uploads are cancelled after 1 day. There's no delete-now button. The 15-day retention raises the average amount stored enough that B2's "3× average stored" free download allowance covers the worker's downloads and the previews. At about 10 videos a month (≈20 GB uploaded), average storage is ≈10 GB, which falls in the free tier, so storage and downloads cost $0.
- **Preview traffic**: while the file is still on her phone (same session), the editor previews from the local `File` using `URL.createObjectURL`, which costs no download traffic. Otherwise it uses a presigned GET that lasts 1 hour.
- **One-time setup script** (`bun run b2:setup`):
  - Sets **CORS via the S3 API** (`PutBucketCors`). Rules set in the B2 web page don't apply to the S3 API. Origins are the dashboard domain only; methods are PUT, GET and HEAD; exposed headers are `ETag`.
  - Sets the **lifecycle rule through the B2 native API** (`b2_update_bucket`).
- Deleting from code always uses the file's **version ID**. A plain S3 delete only hides the file on B2 and you keep paying for it. In v1 the code never deletes, so the lifecycle rule handles all deletion. This note is for any future delete path.

## 7. Clip ingest

When an upload finishes (the `complete` endpoint), the API runs **ffprobe against a presigned URL**. ffprobe only reads the header ranges, which is a few KB. It stores duration, dimensions, rotation, and `isHdr` (color transfer `arib-std-b67` or `smpte2084`). If a clip is HDR, the UI shows a gentle warning: "This clip was filmed in HDR — turn off Settings → Camera → Record Video → HDR Video next time". The render still handles it (see §8).

## 8. Render pipeline (worker)

Job `render-and-upload(projectId)`:

1. Check that `/work` has at least 3× the total input size free. If not, fail with "Server is out of space".
2. Create `/work/<jobId>/`. **Stream** each clip, voiceover, the intro, and the optional outro from B2 to disk.
3. `timeline.buildPlan(project, clips, edits, settings)` produces, for each clip, the ranges to keep, plus the overlays and voice ranges mapped to output time.
4. `render.buildArgs(plan)` produces a single ffmpeg command:
   - Per clip:
     - `trim`/`atrim` for each keep-range, then `concat`
     - `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`
     - HDR clips first get a `zscale`/`tonemap=hable` chain down to BT.709
   - Content audio:
     - Each voice range: `volume=0:enable='between(t,a,b)'` on the original audio, then the voiceover `adelay`-ed to `a` and `amix`-ed in. Its length is clamped to the range (`atrim`/`apad`).
     - Cleanup chain, on by default: `highpass=f=80, afftdn=nr=10:nf=-40` (mild), then `loudnorm=I=-14:TP=-1.5:LRA=11` (single pass). These settings are deliberately conservative to protect voice quality. There's no RNN denoise.
   - Text: one `drawtext` per overlay, using a bundled font, white on `box=1:boxcolor=black@0.5`, with `enable='between(t,a,b)'`. Top, middle and bottom map to fixed y positions.
   - Intro: `xfade=transition=fade:duration=<fadeSeconds>:offset=<introDur-fade>` into the content, with `acrossfade` for the audio. The optional outro joins the same way at the end.
   - Output: `libx264 -preset veryfast -crf 20 -threads 3`, `aac 192k`, `-movflags +faststart`. It runs under `nice -n 10`.
   - Progress: parsed from `-progress pipe:1` (`out_time_ms` / planned duration) and written to `project.progress` (0–80%) at most every 2 s.
5. **YouTube upload** from the local file: `videos.insert` with a resumable upload, including title, description, `privacyStatus`, and `categoryId=27` (Education). Progress covers 80–100%. Then `thumbnails.set` with the thumbnail. The video ID is saved.
6. `finally`: `rm -rf /work/<jobId>` whether the job succeeded or failed. On worker startup, `/work` is wiped as well, for crash recovery.

**Expected load:** a 15-minute 1080p30 render takes about 5–10 minutes on 3 threads and uses a few hundred MB of RAM. Disk peaks at about the size of the inputs plus the output (≈3–4 GB).

**Retries:** the YouTube upload retries 3 times with backoff while the file is still on disk. If that fails, the job ends as `failed` and the file is deleted. **Try again** re-runs the whole job. The originals are still in B2 for 15 days, so she doesn't need to upload again.

## 9. YouTube integration

- A Google Cloud project with **YouTube Data API v3** enabled and an OAuth client (web app). Scope: `youtube.upload`.
- The OAuth consent screen is set to **"In production"**, not Testing, because Testing refresh tokens expire after 7 days. The "unverified app" warning shows once, when the admin connects.
- The admin connects on the Settings page (OAuth redirect, then callback). The refresh token is stored **AES-256-GCM encrypted** (key from env `TOKEN_ENC_KEY`).
- Uploads from an unaudited project are **locked to private**. The Unlisted choice is saved and passed to the API, and she changes visibility in YouTube Studio. The UI says: "It'll be private on YouTube — open YouTube Studio to publish."
- Custom thumbnails need the channel to be phone-verified. This is a one-time check the admin does, and the Settings page notes it.
- Quota: the default 10,000 units/day is plenty for a few uploads a day.

## 10. LLM (Merge Gateway)

```ts
import { createMergeGateway } from "merge-gateway-ai-sdk-provider";
import { generateText } from "ai";

const gateway = createMergeGateway({ apiKey: env.MERGE_GATEWAY_API_KEY });

export async function generateThumbnailPrompt({ title, description, template }) {
  const { text } = await generateText({
    model: gateway(env.MERGE_MODEL),        // e.g. "openai/gpt-5.2"; set in env
    system: template,                        // admin-editable template (placeholder for now)
    prompt: `Title: ${title}\n\nDescription: ${description}`,
  });
  return text.trim();
}
```

- Endpoint: `POST /projects/:id/thumbnail-prompt`. It loads the title and description from the database, not from the request body, and saves the result to `project.thumbnailPrompt`.
- Placeholder template (to be replaced later): *"You write prompts for an image generator to create a YouTube thumbnail for a biology education channel. Produce one prompt: 16:9, bold readable title text, bright clean colours, one clear visual subject related to the topic. Output only the prompt."*
- Rate limit: 10 calls per user per hour. The `llm/` module is shared, so adding "suggest title/description" later is just another function and endpoint.

## 11. Auth & security

- Better Auth email/password with `disableSignUp: true` and the **admin plugin** for roles. `bun run seed:users` creates the admin and editor accounts.
- Every Elysia route except `/api/auth/*` and the OAuth callback requires a session. Settings, YouTube and user routes require `admin`. Editors only see their own projects.
- Presign endpoints check that the requested key is under the caller's project, so users can't request arbitrary keys.
- B2 application key is limited to the one bucket. The CORS origin is limited to the dashboard domain.
- Better Auth's built-in rate limiting is on. Cookies are secure and httpOnly.
- Deployed on a private subdomain behind the existing reverse proxy with TLS.

## 12. Deployment

A Docker Compose file with these services:
- `web` (Next.js)
- `server` (Elysia API)
- `worker` (same image as `server`, command `bun run src/worker.ts`, with an `ffmpeg` static build that includes `zimg` for tonemapping, and a `/work` volume)
- `postgres`

The worker gets `cpus: 3` and `mem_limit: 3g` so a render can't starve the rest of the VPS. Env vars:
- `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
- `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APP_KEY`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `TOKEN_ENC_KEY`
- `MERGE_GATEWAY_API_KEY`, `MERGE_MODEL`

## 13. Error handling

| Failure | Behaviour |
|---|---|
| Upload drops on mobile data | Uppy resumes. If it's abandoned, the clip shows "failed — tap to retry"; lifecycle removes the orphaned parts |
| ffprobe can't read the clip | The clip is marked failed: "This file isn't a video we can read" |
| Not enough disk | The job fails before downloading anything, with a clear message |
| ffmpeg non-zero exit | The last 20 stderr lines are logged, and she sees "Rendering failed — try again or ask for help" |
| YouTube token revoked/expired | The job fails with "YouTube needs reconnecting (ask admin)", and the admin sees a banner |
| YouTube quota exceeded | The job fails with "YouTube's daily limit reached — try again tomorrow" |
| LLM error/timeout (30 s) | An inline error with a retry button. It doesn't affect anything else |
| Worker crash mid-job | pg-boss retries once. `/work` is wiped on startup |

## 14. Testing

- **Unit (bun test)**:
  - `timeline/`: keep-ranges, overlapping cuts, source→output mapping across clips, and edits that fall inside cut ranges get dropped or clamped
  - `render.buildArgs`: snapshot-style assertions on the filtergraph
  - `llm/`: with a mocked provider
  - presign key-ownership checks
- **Integration**: generate tiny test clips with `ffmpeg -f lavfi testsrc/sine`, run the real render with two clips, a cut, an overlay, a voiceover and an intro, then assert the output duration, resolution and fps with ffprobe. B2 and YouTube are replaced by in-memory or local stubs behind their module interfaces.
- **Manual**: a real iPhone Safari pass covering upload, preview, record, copy prompt and send, plus one real private upload to YouTube.

## 15. Out of scope (v1)

- LLM suggestions for title and description, and the fill-in title/description format (the `llm/` module is ready for it)
- Transcripts, captions, chapters
- Text-to-speech or voice cloning
- A built-in thumbnail maker or browser automation of ChatGPT
- More than one YouTube channel, more than one render at once, a Cloudflare proxy in front of B2
- A manual delete button (lifecycle handles deletion)
