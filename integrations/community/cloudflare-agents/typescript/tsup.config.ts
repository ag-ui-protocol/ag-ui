import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  external: ["@ag-ui/client", "@ag-ui/core", "rxjs", "ai", "cloudflare:workers"],
});
