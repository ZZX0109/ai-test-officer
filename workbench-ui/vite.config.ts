import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // The Workbench is also the operator's live test console. Injecting a
    // partially updated React module graph into that console can interrupt an
    // active Run even when the final source compiles. Keep the operator page
    // stable; verified changes become visible after the supervised restart.
    hmr: false,
    proxy: {
      "/agent-api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/agent-api/, "")
      }
    }
  },
  preview: {
    proxy: {
      "/agent-api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/agent-api/, "")
      }
    }
  }
});
