import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    exports: true,
    fixedExtension: false,
    sourcemap: true,
    clean: true,
    platform: "node",
  },
  {
    entry: {
      "examples/server": "examples/server.ts",
      "process-launcher": "src/process-launcher.ts",
    },
    format: ["cjs"],
    dts: false,
    fixedExtension: false,
    clean: false,
    platform: "node",
  },
]);
