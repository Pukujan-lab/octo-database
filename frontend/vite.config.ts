import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// The app is a same-origin client of the Octo API, served from the site root.
// `base` stays default ("/") so asset URLs and the router basename line up; in
// dev the server runs on :3000 (the port the Playwright e2e suite expects) and
// proxies the API routes to the Node service on :3001.
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 3000,
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
    outDir: path.resolve(__dirname, "../dist"),
    emptyOutDir: true,
    // Not the default assets/: the edge cached a 404 for a live bundle URL during
    // a container swap, and a content-hashed name stays poisoned until its
    // directory changes.
    assetsDir: "static",
  },
}));
