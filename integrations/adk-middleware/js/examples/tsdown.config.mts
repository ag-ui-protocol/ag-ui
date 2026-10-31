import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  target: "node20.19",
  checks: { legacyCjs: false },
  dts: true,
  exports: true,
  fixedExtension: false,
  sourcemap: true,
  clean: true,
  minify: false,
});
