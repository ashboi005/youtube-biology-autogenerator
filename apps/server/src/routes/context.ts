import { Elysia } from "elysia";

import { auth } from "../services";
import { HttpError, isAdmin } from "./access";

/** Adds `user` to handlers. `auth: true` = any signed-in user, `admin: true` = admin only. */
export const authContext = new Elysia({ name: "auth-context" })
  .error({ HttpError })
  .onError({ as: "global" }, ({ code, error, set, request }) => {
    if (code === "HttpError") {
      set.status = error.status;
      return { error: error.message };
    }
    if (code === "VALIDATION" || code === "NOT_FOUND") return;
    console.error(`[api] ${request.method} ${new URL(request.url).pathname}`, error);
    set.status = 500;
    return { error: "Something went wrong on the server — try again" };
  })
  .macro({
    auth: {
      async resolve({ status, request: { headers } }) {
        const session = await auth.api.getSession({ headers });
        if (!session) return status(401, { error: "Please sign in" });
        return { user: session.user as typeof session.user & { role?: string | null } };
      },
    },
    admin: {
      async resolve({ status, request: { headers } }) {
        const session = await auth.api.getSession({ headers });
        if (!session) return status(401, { error: "Please sign in" });
        const user = session.user as typeof session.user & { role?: string | null };
        if (!isAdmin(user)) return status(403, { error: "Admins only" });
        return { user };
      },
    },
  });
