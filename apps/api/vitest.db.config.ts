import { defineConfig } from "vitest/config";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://patrol:patrol@127.0.0.1:5433/patrol_test";

export default defineConfig({
  test: {
    name: "api-db",
    include: ["test/db/**/*.test.ts"],
    globalSetup: ["test/db/global-setup.ts"],
    setupFiles: ["test/db/per-file-reset.ts"],
    // The suites share one throwaway database; they must not race it.
    fileParallelism: false,
    testTimeout: 30_000,
    env: { TEST_DATABASE_URL },
  },
});
