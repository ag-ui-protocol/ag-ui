import path from "path";
import { mergeConfig, defineConfig } from "vitest/config";
import baseConfig from "../../vitest.base";

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        "@/": path.resolve(__dirname, "./src") + "/",
      },
    },
  }),
);
