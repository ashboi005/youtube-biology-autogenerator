# Biology Studio

A private, phone-first dashboard for turning iPhone clips into a YouTube upload:
**Clips → Edit (cut / text / re-record voice) → Title & description → Thumbnail (ChatGPT prompt) → Send to YouTube (private)**.

- `apps/web` — Next.js UI (what she uses on her phone)
- `apps/server` — Elysia API (`src/index.ts`) and the render worker (`src/worker.ts`)
- `packages/db` — Drizzle schema (Postgres); `packages/auth` — Better Auth (sign-up disabled)

Design: `docs/superpowers/specs/2026-09-24-youtube-autogenerator-design.md`

## How a video is made

1. The phone uploads clips **directly to Backblaze B2** (multipart, presigned URLs). The server never handles video bytes.
2. Edits are saved as data (cut ranges, text, voice recordings), stored against each clip's own timeline.
3. **Send** queues a job (pg-boss, in Postgres). The worker streams the files to disk, runs a **single ffmpeg pass**
   (intro fade, cuts, text, voice swap, gentle audio cleanup, 1080p30 H.264), uploads to YouTube as **private**,
   sets the thumbnail, then deletes its working folder.
4. B2 deletes uploads automatically after ~16 days (lifecycle rule). That retention keeps download traffic
   inside B2's free allowance, so the bill stays at about $0.

## Local development

```bash
bun install
docker compose up -d postgres                   # Postgres on localhost:5433
# Local S3 stand-in for B2:
docker run -d --name ytbio-minio -p 127.0.0.1:9000:9000 \
  -e MINIO_ROOT_USER=devkey -e MINIO_ROOT_PASSWORD=devsecret123 quay.io/minio/minio server /data
# create bucket "ytbio-dev" (e.g. with the AWS CLI or MinIO console), then in apps/server/.env:
#   B2_ENDPOINT=http://localhost:9000  B2_REGION=us-east-1  B2_BUCKET=ytbio-dev
#   B2_KEY_ID=devkey  B2_APP_KEY=devsecret123
bun run db:push
cd apps/server && bun run seed:users -- --email you@example.com --password '...' --role admin
bun run dev                     # web :3001, api :3000
cd apps/server && bun run dev:worker
cd apps/server && bun test      # unit + real-ffmpeg integration tests
```

Homebrew's ffmpeg has no `drawtext`/`zscale`, so text overlays and HDR only render in the Docker worker image (or a full ffmpeg build).
The integration test skips overlays when `drawtext` is missing.

## Production setup (one time)

### 1. Backblaze B2
1. Create a **private** bucket. Create an application key **restricted to that bucket** (read + write).
2. Put the values in `apps/server/.env`: `B2_ENDPOINT` (e.g. `https://s3.us-west-004.backblazeb2.com`), `B2_REGION` (`us-west-004`), `B2_BUCKET`, `B2_KEY_ID`, `B2_APP_KEY`.
3. `cd apps/server && bun run b2:setup`. This sets the lifecycle rule (B2 native API) and CORS for the dashboard origin (S3 API).
   CORS rules made in the B2 web UI **don't** apply to S3 presigned uploads, so use this script.

### 2. YouTube (Google Cloud)
1. Create a project and enable **YouTube Data API v3**.
2. OAuth consent screen: External, add your Google account as a test user, then **Publish app → In production**.
   (In Testing mode refresh tokens expire after 7 days.) The "unverified app" warning shows once when you connect. That's expected.
3. Create an OAuth client (Web application). Set the redirect URI to `https://<api-domain>/api/youtube/callback`.
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and `TOKEN_ENC_KEY` (`openssl rand -hex 32`).
5. Make sure the channel is **phone-verified**; custom thumbnails need it.
6. Sign in as admin → **Settings → Connect YouTube**.

Videos from an unaudited API project are locked to **private**. She publishes from YouTube Studio (the app links there).

### 3. LLM (Merge Gateway)
Set `MERGE_GATEWAY_API_KEY` and optionally `MERGE_MODEL` (default `openai/gpt-5.2`).
Edit the thumbnail prompt template in **Settings**.

### 4. Accounts
Sign-up is disabled. Create accounts from the server:
```bash
cd apps/server
bun run seed:users -- --email mom@example.com --name "Mom" --password '...'          # editor
bun run seed:users -- --email you@example.com --password '...' --role admin
```
Re-running with the same email resets the password.

### 5. Deploy
```bash
# apps/server/.env: BETTER_AUTH_URL=https://<api-domain>, CORS_ORIGIN/WEB_URL=https://<web-domain>, ...
# docker-compose.yml: set web build arg NEXT_PUBLIC_SERVER_URL=https://<api-domain> (baked in at build time)
docker compose up -d --build
docker compose exec server bun run --cwd /app/packages/db db:push   # or run db:push from a machine with DB access
```
Put both behind your reverse proxy with TLS (auth cookies are `Secure; SameSite=None`).
The `worker` service is capped at 3 CPUs / 3 GB RAM and uses the `work` volume as scratch space.

## Recording tips (for her iPhone)
- Settings → Camera → Record Video: **1080p at 30 fps**, turn **HDR Video off**, and turn **Auto FPS off**.
- Landscape, on the tripod. Portrait clips work but get black bars.
