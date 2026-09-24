import { defineConfig } from "drizzle-kit";
import "varlock/auto-load";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  // Only manage our tables — pg-boss owns the "pgboss" schema and push must never drop it.
  schemaFilter: ["public"],
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
});
