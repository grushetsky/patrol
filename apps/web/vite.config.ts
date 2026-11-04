import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
