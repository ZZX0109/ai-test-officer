import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
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
