import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // `pnpm dev` against a local hive (`pnpm --filter hive dev` or the compose stack).
  server: { proxy: { "/v1": "http://127.0.0.1:8800" } },
  // React only ships `act` in its development build; a shell with NODE_ENV=production would break tests.
  test: { include: ["src/**/*.test.tsx"], environment: "jsdom", env: { NODE_ENV: "test" } },
});
