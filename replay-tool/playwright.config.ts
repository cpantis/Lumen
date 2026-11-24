import { defineConfig } from "@playwright/test";

/**
 * E2E: builds the app (prebuild generates public/demo.mcap), serves the static build,
 * loads the synthetic recording and exercises the main flows + an axe-core audit.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 1600, height: 1000 },
    trace: "off",
  },
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
