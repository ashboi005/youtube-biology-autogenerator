/**
 * Create (or reset the password of) a dashboard account. Self-signup is disabled.
 *   bun run seed:users -- --email mom@example.com --name "Mom" --password '...' [--role admin|editor]
 */
import { user } from "@youtube-biology-autogenerator/db/schema/index";
import { eq } from "drizzle-orm";
import { parseArgs } from "node:util";

import { auth, db } from "../src/services";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    password: { type: "string" },
    role: { type: "string", default: "editor" },
  },
});

const { email, name, password, role } = values;
if (!email || !password || password.length < 8 || (role !== "admin" && role !== "editor")) {
  console.error("Usage: --email <email> --password <min 8 chars> [--name <name>] [--role admin|editor]");
  process.exit(1);
}

const ctx = await auth.$context;
const hash = await ctx.password.hash(password);
const [existing] = await db.select().from(user).where(eq(user.email, email.toLowerCase()));

if (existing) {
  await ctx.internalAdapter.updatePassword(existing.id, hash);
  await db.update(user).set({ role, ...(name ? { name } : {}) }).where(eq(user.id, existing.id));
  console.log(`✓ Updated ${email} (role: ${role})`);
} else {
  const created = await ctx.internalAdapter.createUser({
    email: email.toLowerCase(),
    name: name ?? email.split("@")[0]!,
    emailVerified: true,
    role,
  }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: hash,
  });
  console.log(`✓ Created ${email} (role: ${role})`);
}
process.exit(0);
