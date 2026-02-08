import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: false, // Disable DTS generation for now due to monorepo linkage issues
  sourcemap: true,
  clean: true,
  external: ["@ag-ui/client", "@ag-ui/core", "rxjs"],
});
