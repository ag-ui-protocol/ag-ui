import { defineConfig } from "tsdown";

export default defineConfig((inlineConfig) => ({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  exports: true,
  fixedExtension: false,
  sourcemap: true,
  unbundle: true, // Don't bundle dependencies to allow for better tree-shaking in consuming projects
  clean: !inlineConfig.watch, // Don't clean in watch mode to prevent race conditions
  minify: !inlineConfig.watch, // Don't minify in watch mode for faster builds
}));
