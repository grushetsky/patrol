import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "worker-unit",
    include: ["test/**/*.test.ts"],
    exclude: ["test/db/**"],
    testTimeout: 10_000,
  },
});
