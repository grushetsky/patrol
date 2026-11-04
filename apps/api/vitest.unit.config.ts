import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api-unit",
    include: ["test/**/*.test.ts"],
    exclude: ["test/db/**", "node_modules/**"],
  },
});
