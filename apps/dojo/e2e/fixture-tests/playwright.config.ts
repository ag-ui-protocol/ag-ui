import { defineConfig, devices } from "@playwright/test";

// Runs the protocol-check scenarios against their own local server; no Dojo,
// no aimock. protocol-check.test.ts starts this config and judges the results.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: { headless: true },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
