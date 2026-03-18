import type { NextConfig } from "next";
import createMDX from "@next/mdx";
import fs from "fs";
import path from "path";

const withMDX = createMDX({
  extension: /\.mdx?$/,
  options: {
    // If you use remark-gfm, you'll need to use next.config.mjs
    // as the package is ESM only
    // https://github.com/remarkjs/remark-gfm#install
    remarkPlugins: [],
    rehypePlugins: [],
    // If you use `MDXProvider`, uncomment the following line.
    providerImportSource: "@mdx-js/react",
  },
});

// Auto-detect if @copilotkit packages are linked from outside this repo
// (i.e. local-install was run). If so, extend the output file tracing root
// so Turbopack can resolve CSS subpath exports through cross-repo symlinks.
const repoRoot = path.resolve(import.meta.dirname, "../..");
let outputFileTracingRoot: string | undefined;
try {
  const realPath = fs.realpathSync(
    path.join(import.meta.dirname, "node_modules/@copilotkit/react-core"),
  );
  if (!realPath.startsWith(repoRoot)) {
    outputFileTracingRoot = path.resolve(repoRoot, "..");
  }
} catch {}

const nextConfig: NextConfig = {
  /* config options here */
  // Configure pageExtensions to include md and mdx
  pageExtensions: ["ts", "tsx", "js", "jsx", "md", "mdx"],
  ...(outputFileTracingRoot && {
    experimental: { outputFileTracingRoot },
  }),
  webpack: (config, { isServer }) => {
    // Ignore the demo files during build
    config.module.rules.push({
      test: /agent\/demo\/crew_enterprise\/ui\/.*\.(ts|tsx|js|jsx)$/,
      loader: "ignore-loader",
    });

    return config;
  },
  serverExternalPackages: ["@mastra/libsql", "@copilotkit/runtime"],
};

// Merge MDX config with Next.js config
export default withMDX(nextConfig);
