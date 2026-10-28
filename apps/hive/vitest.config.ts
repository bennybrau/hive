import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests share one real Postgres database; run files serially.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
