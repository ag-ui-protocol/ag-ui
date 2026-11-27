import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["src/__tests__/**/*.test.ts"], testTimeout: 15000 },
});
