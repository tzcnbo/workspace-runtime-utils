import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.API_TARGET || "http://localhost:8080";
const port = Number(process.env.PORT || 24927);
const base = process.env.BASE_PATH || "/";

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    outDir: "dist/public",
  },
  server: {
    host: "0.0.0.0",
    port,
    strictPort: false,
    proxy: {
      "/api": apiTarget,
      "/v1": apiTarget,
    },
  },
  preview: {
    host: "0.0.0.0",
    port,
  },
});
