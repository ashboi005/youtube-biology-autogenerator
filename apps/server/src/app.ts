import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";

import { ENV } from "./env.server";
import { clipRoutes } from "./routes/clips";
import { authContext } from "./routes/context";
import { editRoutes } from "./routes/edits";
import { projectRoutes } from "./routes/projects";
import { getYoutubeConnection } from "./routes/repo";
import { settingsRoutes } from "./routes/settings";
import { auth } from "./services";

export const app = new Elysia()
  .use(
    cors({
      origin: ENV.CORS_ORIGIN,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  )
  .all("/api/auth/*", async ({ request, status }) => {
    if (["POST", "GET"].includes(request.method)) return auth.handler(request);
    return status(405);
  })
  .group("/api", (api) =>
    api
      .use(authContext)
      .get(
        "/me",
        async ({ user }) => {
          const role = user.role ?? "editor";
          const yt = role === "admin" ? await getYoutubeConnection() : null;
          return { id: user.id, name: user.name, email: user.email, role, youtubeNeedsReconnect: Boolean(yt?.needsReconnect) };
        },
        { auth: true },
      )
      .use(projectRoutes)
      .use(clipRoutes)
      .use(editRoutes)
      .use(settingsRoutes),
  )
  .get("/", () => "OK");
