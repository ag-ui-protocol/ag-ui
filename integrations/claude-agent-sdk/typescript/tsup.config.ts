import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "@ag-ui/client",
    "@ag-ui/core",
    "@anthropic-ai/claude-agent-sdk",
    "@anthropic-ai/sdk",
    "zod",
  ],
});

