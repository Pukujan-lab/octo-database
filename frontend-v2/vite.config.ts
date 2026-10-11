import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// The app is a same-origin client of the Octo API, mounted at /v2/ alongside the
// v1 UI at /. `base` must match the mount path so asset URLs and the router
// basename line up; in dev the same base applies and the API routes are proxied
// to the Node service on :3001.
export default defineConfig(() => ({
  base: "/v2/",
  server: {
    host: "::",
    port: 8080,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      // changeOrigin is off: the OAuth server derives its public origin (issuer,
      // redirect targets, the 401 metadata URL) from the Host header, and in dev
      // the browser is talking to :8080. Rewriting Host to :3001 would bounce the
      // login redirect to the wrong origin.
      "/mcp": {
        target: "http://localhost:3001",
      },
      "/oauth": {
        target: "http://localhost:3001",
      },
      "/.well-known": {
        target: "http://localhost:3001",
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../dist/v2"),
    emptyOutDir: true,
  },
}));
