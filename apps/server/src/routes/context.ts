import { Elysia } from "elysia";

import { auth } from "../services";
import { HttpError, isAdmin } from "./access";

/** Adds `user` to handlers. `auth: true` = any signed-in user, `admin: true` = admin only. */
export const authContext = new Elysia({ name: "auth-context" })
  .error({ HttpError })
  .onError({ as: "global" }, ({ code, error, set }) => {
    if (code === "HttpError") {
      set.status = error.status;
      return { error: error.message };
    }
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
