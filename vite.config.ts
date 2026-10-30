import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
import { isCssModule, updateCssTypes } from "./scripts/css-types.ts";

const host = process.env.TAURI_DEV_HOST;

/** Keeps the CSS module types current as the CSS changes (see scripts/css-types.ts). */
function cssTypes(): Plugin {
  return {
    name: "clnk:css-types",
    apply: "serve",
    configureServer(server) {
      const update = (path: string) => {
        if (!isCssModule(path)) return;
        try {
          if (updateCssTypes(path))
            server.config.logger.info(`CSS module types updated: ${path}`);
        } catch (err) {
          server.config.logger.warn(`CSS module types: ${String(err)}`);
        }
      };
      server.watcher
        .on("add", update)
        .on("change", update)
        .on("unlink", update);
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), cssTypes()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and the backend
      ignored: ["**/src-tauri/**", "**/server/**"],
    },
    // Forward API calls to the backend so the dev server can be used as the backend URL.
    proxy: {
      "/api": {
        target: process.env.CLNK_BACKEND || "http://127.0.0.1:8787",
        ws: true,
      },
    },
  },
}));
