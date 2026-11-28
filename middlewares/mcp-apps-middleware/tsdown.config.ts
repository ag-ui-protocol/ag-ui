import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", a2ui: "src/a2ui/index.ts" },
  format: ["cjs", "esm"],
  dts: true,
  exports: true,
  fixedExtension: false,
  sourcemap: true,
  clean: true,
  minify: true,
});
