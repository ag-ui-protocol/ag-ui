// Decides which CI areas a pull request touches, for required-checks.yml.
//
// Each list below is an exact copy of the `push.paths` list in the named
// workflow, followed by this workflow's own files (a change to how the checks
// are called must run every check). required-checks-areas.test.mjs fails if a
// copy drifts from its workflow.
//
// Semantics follow GitHub's `paths:` filter: patterns are evaluated in order
// and the LAST pattern that matches a file decides (a leading `!` excludes).
// Supported syntax is the subset these lists use: `**`, `*` and literal text.
// Any other glob metacharacter is rejected, so a new pattern cannot be
// silently mis-read.
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const SELF = [
  ".github/workflows/required-checks.yml",
  ".github/scripts/required-checks-areas.mjs",
];

export const AREAS = {
  lint: {
    workflow: ".github/workflows/lint-typescript.yml",
    paths: [
      "sdks/typescript/**",
      "apps/**",
      "eslint.config.base.mjs",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "package.json",
      "nx.json",
      ".github/workflows/lint-typescript.yml",
    ],
  },
  typecheck: {
    workflow: ".github/workflows/typecheck-typescript.yml",
    paths: [
      "sdks/**",
      "integrations/**",
      "middlewares/**",
      "spec/**",
      "scripts/check-types.mjs",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "package.json",
      "nx.json",
      ".node-version",
      ".github/workflows/typecheck-typescript.yml",
    ],
  },
  unit_typescript: {
    workflow: ".github/workflows/unit-typescript-sdk.yml",
    paths: [
      "sdks/typescript/**",
      "typescript-sdk/**",
      "integrations/**",
      "middlewares/**",
      "spec/**",
      "sdks/python/ag_ui/_generated/**",
      "sdks/python/ag_ui/core/**",
      "sdks/dotnet/src/AGUI.Abstractions/**",
      "sdks/dotnet/src/AGUI.Protobuf/Generated/**",
      "sdks/dotnet/tests/AGUI.Protobuf.UnitTests/Fixtures/**",
      "docs/spec/**",
      "docs/quickstart/**",
      "sdks/fixtures/**",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "package.json",
      "nx.json",
      ".github/workflows/unit-typescript-sdk.yml",
    ],
  },
  unit_python: {
    workflow: ".github/workflows/unit-python-sdk.yml",
    paths: [
      "spec/**",
      "sdks/fixtures/**",
      "sdks/python/**",
      "integrations/langgraph/python/**",
      "integrations/langgraph/cross-runtime-parity-cases.json",
      "integrations/watsonx/python/**",
      "integrations/adk-middleware/python/**",
      "integrations/aws-strands/python/**",
      "integrations/aws-strands/error-codes.json",
      "integrations/langroid/python/**",
      "integrations/crew-ai/python/**",
      "integrations/claude-managed-agents/python/**",
      "integrations/agent-spec/python/**",
      "integrations/claude-agent-sdk/python/**",
      "integrations/antigravity/python/**",
      "**/uv.lock",
      "**/pyproject.toml",
      "!**/examples/**",
      "integrations/crew-ai/python/examples/pyproject.toml",
      "integrations/crew-ai/python/examples/uv.lock",
      ".github/python-toolchain.env",
      ".github/workflows/unit-python-sdk.yml",
      ".github/actions/**",
    ],
  },
};

export function pullRequestPaths(area) {
  return [...AREAS[area].paths, ...SELF];
}

function toRegExp(glob) {
  if (/[?[\]{}()+@!]/.test(glob)) {
    throw new Error(`unsupported glob syntax in '${glob}'`);
  }
  let out = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else {
      out += glob[i].replace(/[.^$|\\/]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

export function included(file, patterns) {
  let result = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    if (toRegExp(negated ? pattern.slice(1) : pattern).test(file)) {
      result = !negated;
    }
  }
  return result;
}

export function classify(files) {
  return Object.fromEntries(
    Object.keys(AREAS).map((area) => [
      area,
      files.some((file) => included(file, pullRequestPaths(area))),
    ]),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const [area, hit] of Object.entries(classify(files))) {
    console.log(`${area}=${hit}`);
  }
}
