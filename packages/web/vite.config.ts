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
        // Splitting these out keeps the map's weight off the first paint and lets the
        // app shell and the map cache independently across deploys.
        manualChunks: {
          map: ["maplibre-gl", "pmtiles"],
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
