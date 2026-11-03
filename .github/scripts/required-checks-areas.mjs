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
// Any other glob metacharacter, a `\` escape and a bare `!` are rejected, so a
// new pattern cannot be silently mis-read (GitHub reads `\` as an escape).
//
// The changed-file list is GitHub's for pull_request: the three-dot diff from
// the merge base to the PR head. When the merge base cannot be found, or the
// list is longer than GitHub evaluates, every area is selected (fail closed).
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#git-diff-comparisons
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";

// GitHub matches path filters against at most this many changed files.
export const MAX_FILES = 3000;

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
  if (glob === "" || /[?[\]{}()+@!\\]/.test(glob)) {
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
  // `s`: a file name may contain a newline, and `.` must still match it.
  return new RegExp(`^${out}$`, "s");
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

export function validate(patterns) {
  for (const pattern of patterns) {
    toRegExp(pattern.startsWith("!") ? pattern.slice(1) : pattern);
  }
}

export function classify(files) {
  return Object.fromEntries(
    Object.keys(AREAS).map((area) => [
      area,
      files.some((file) => included(file, pullRequestPaths(area))),
    ]),
  );
}

// Parses `git -c core.quotePath=false diff -z --name-only` output: each path
// is written verbatim and ends with a NUL. A newline-separated list is
// rejected: there git quotes some names (non-ASCII, `"`, `\`, tab, newline),
// and a quoted name matches no pattern, which would skip every check.
export function parseChangedFiles(text) {
  if (text !== "" && !text.endsWith("\0")) {
    throw new Error("changed-file list must be NUL-terminated (git diff -z)");
  }
  return text
    .split("\0")
    .map((file) => file.replace(/\r$/, ""))
    .filter(Boolean);
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Files changed between the merge base of base and head, and head; null when
// that cannot be known (shallow clone or no merge base).
export function changedFiles(base, head, cwd = process.cwd()) {
  if (git(cwd, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    return null;
  }
  let mergeBase;
  try {
    mergeBase = git(cwd, ["merge-base", base, head]).trim();
  } catch {
    return null;
  }
  // --no-renames lists both sides of a rename, as the paths filter does.
  // -z with core.quotePath=false writes each path verbatim, NUL-ended;
  // without them git quotes unusual names and they match no area.
  return parseChangedFiles(
    git(cwd, [
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${mergeBase}...${head}`,
    ]),
  );
}

// { areas, reason }: reason is set when every area is selected to fail closed.
export function classifyRange(base, head, cwd = process.cwd()) {
  const files = changedFiles(base, head, cwd);
  let reason = null;
  if (files === null) {
    reason = `no merge base for ${base} and ${head} (shallow clone or unrelated histories)`;
  } else if (files.length > MAX_FILES) {
    reason = `${files.length} changed files, over GitHub's ${MAX_FILES}-file limit`;
  }
  if (reason) {
    const areas = Object.fromEntries(Object.keys(AREAS).map((a) => [a, true]));
    return { areas, reason, count: files?.length ?? null };
  }
  return { areas: classify(files), reason, count: files.length };
}

// Run as a script (directly or through a symlink), not when imported. Real
// paths are compared so a symlinked invocation still prints its areas, and a
// missing argv[1] (e.g. `node -e`) means imported, never a throw.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

// node required-checks-areas.mjs <base> <head>
if (isMain()) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: required-checks-areas.mjs <base> <head>");
    process.exit(2);
  }
  const { areas, reason, count } = classifyRange(base, head);
  console.error(`Changed files: ${count ?? "unknown"}`);
  if (reason) console.error(`::warning::Selecting every area: ${reason}.`);
  // Every area is printed, as an explicit true or false: the final
  // required-checks job fails on any area output that is not one of the two.
  for (const [area, hit] of Object.entries(areas)) {
    console.log(`${area}=${hit === true ? "true" : "false"}`);
  }
}
