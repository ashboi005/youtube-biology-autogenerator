FROM oven/bun:1 AS builder
WORKDIR /app

COPY . .
RUN --mount=type=secret,id=web_env,target=/app/apps/web/.env.local --mount=type=secret,id=server_env,target=/app/apps/server/.env.local --mount=type=cache,target=/root/.bun/install/cache bun install

ENV NODE_ENV=production
RUN --mount=type=secret,id=web_env,target=/app/apps/web/.env.local --mount=type=secret,id=server_env,target=/app/apps/server/.env.local cd apps/server && bun run build

# Static ffmpeg 8 with libx264, freetype (drawtext) and zimg (HDR tonemapping).
FROM mwader/static-ffmpeg:8.0 AS ffmpeg

FROM oven/bun:1 AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=builder /app /app

EXPOSE 3000

WORKDIR /app/apps/server
# The API; the worker service overrides this with `bun dist/worker.mjs`.
CMD ["bun", "dist/index.mjs"]
