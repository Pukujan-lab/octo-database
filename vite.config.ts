import { defineConfig } from 'vite';

// The app itself lives in frontend-v2/ and is built and served from there (see
// the root `dev` and `build` scripts). This config remains as the Vitest project
// file: the unit and integration tests run through it, while the Playwright e2e
// specs are excluded because they drive a real browser against the dev servers.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
  },
});
