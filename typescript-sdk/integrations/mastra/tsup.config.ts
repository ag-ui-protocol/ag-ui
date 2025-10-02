import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    copilotkit: "src/copilotkit.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
});
