import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    tanstackStart(), // must come before react()
    viteReact(),
  ],
  // The workspace i18n package ships TypeScript source, so it must be
  // bundled for SSR rather than externalized as a node_modules dependency.
  ssr: { noExternal: ["@patrol/i18n"] },
  server: {
    // Port 3000 matches the compose mapping; host-run development proxies
    // /api to the API's listener, which itself mounts routes under /api, so
    // no path rewrite is needed.
    port: 3000,
    proxy: {
      "/api": {
        target: process.env.PATROL_API_PROXY_TARGET ?? "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
});
