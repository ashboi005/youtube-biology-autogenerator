import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import type { Database } from "@youtube-biology-autogenerator/db";
import * as schema from "@youtube-biology-autogenerator/db/schema/auth";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";

export type AuthConfig = {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  CORS_ORIGIN: string;
};

export function createAuth(
  env: AuthConfig,
  database: Database,
  desktopOrigins: readonly string[] = [],
) {
  return betterAuth({
    database: drizzleAdapter(database, {
      provider: "pg",
      schema,
    }),
    trustedOrigins: [env.CORS_ORIGIN, ...desktopOrigins],
    // No self-signup: accounts are created with `bun run seed:users`.
    emailAndPassword: { enabled: true, disableSignUp: true },
    rateLimit: { enabled: true, window: 60, max: 30 },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    advanced: {
      defaultCookieAttributes: {
        sameSite: "none",
        secure: true,
        httpOnly: true,
      },
    },
    plugins: [admin({ defaultRole: "editor", adminRoles: ["admin"] })],
  });
}

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
