import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // `pnpm dev` against a local hive (`pnpm --filter hive dev` or the compose stack).
  server: { proxy: { "/v1": "http://127.0.0.1:8800" } },
  // React only ships `act` in its development build; a shell with NODE_ENV=production would break tests.
  // TZ is pinned so a test that reads a date ("October 3, 2026") passes on any machine, not only one set to UTC.
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "jsdom", env: { NODE_ENV: "test", TZ: "UTC" } },
});
