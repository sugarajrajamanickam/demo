import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During local dev the React app runs on :5173 and proxies API calls to
// the FastAPI backend on :8000. In the container the static build is
// served by FastAPI so the proxy is irrelevant.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/token": "http://localhost:8000",
    },
  },
  build: {
    outDir: "dist",
  },
});
