import { defineConfig } from "vitest/config";

/**
 * Shared Vitest base configuration for all TypeScript packages.
 * Import and merge this in each package's vitest.config.ts using:
 *
 * @example
 * import { mergeConfig } from "vitest/config";
 * import baseConfig from "../../vitest.base";
 *
 * export default mergeConfig(baseConfig, defineConfig({
 *   // package-specific overrides
 * }));
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json", "html"],
      reportsDirectory: "./coverage",
      // Target: 80% coverage for statements, branches, functions, and lines
      // Thresholds are not enforced to allow builds to pass while coverage improves
    },
  },
});
