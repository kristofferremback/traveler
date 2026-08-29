import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    // The API runs separately in development; one origin in production.
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: true } },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        /**
         * Splitting these out keeps the map's weight off the first paint and lets the
         * app shell, React and the map cache independently across deploys.
         *
         * By module path rather than by package name. Naming the packages missed most of
         * React, because what the app imports is `react-dom/client` and the object form
         * matches the id it resolves to and nothing else; react-dom's 170-odd kilobytes
         * therefore sat in the app chunk and were downloaded again after every deploy,
         * which is the one thing naming it here was meant to prevent.
         */
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/node_modules\/(maplibre-gl|pmtiles)\//.test(id)) return "map";
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) {
            return "react";
          }
        },
      },
    },
  },
});
