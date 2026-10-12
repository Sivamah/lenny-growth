/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // VITE_API_BASE_URL: backend origin (no trailing slash).
  // When running dev proxy mode, set this to "" so the client uses relative
  // URLs that the proxy rewrites; otherwise set to "http://localhost:8000".
  // When both are unset the client falls back to http://localhost:8000 (see client.ts).
  const backendTarget = env.VITE_PROXY_TARGET ?? "http://localhost:8000";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/health": { target: backendTarget, changeOrigin: true },
        "/api": { target: backendTarget, changeOrigin: true },
        "/sessions": { target: backendTarget, changeOrigin: true },
      },
    },
    preview: {
      port: 5173,
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      css: false,
    },
  };
});