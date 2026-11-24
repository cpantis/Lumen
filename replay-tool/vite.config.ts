import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

/** Git commit embedded in every export for traceability (falls back to "dev"). */
function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  plugins: [react()],
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "1.0.0"),
    __GIT_COMMIT__: JSON.stringify(process.env.GIT_COMMIT ?? gitCommit()),
  },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2500 },
  server: { port: 5173 },
  test: {
    include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
    environment: "node",
  },
} as never);
