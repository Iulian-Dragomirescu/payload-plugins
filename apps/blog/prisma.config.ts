import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * The connection URL lives here rather than in `schema.prisma`, so this file is
 * the one place that knows how to reach the database. The adapter opens no
 * connection of its own, it reuses the client in `src/prisma.ts`.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
  },
  
});
