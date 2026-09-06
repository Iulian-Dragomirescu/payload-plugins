import { defineConfig } from "vitest/config";

export default defineConfig({
  // The `source` condition runs the example against the packages' `src`, with
  // no build step in between.
  resolve: { conditions: ["source"] },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // The suite waits on the containers in `docker-compose.yml`.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One database, one schema: parallel files would race on the same rows.
    fileParallelism: false,
    passWithNoTests: true,
  },
});
