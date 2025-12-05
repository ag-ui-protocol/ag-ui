import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    alias: {
      "@/": new URL("./src/", import.meta.url).pathname,
    },
  },
});
