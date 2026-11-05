import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "mail",
    include: ["test/**/*.test.ts"],
  },
});
