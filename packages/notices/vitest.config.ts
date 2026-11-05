import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "notices",
    include: ["test/**/*.test.ts"],
  },
});
