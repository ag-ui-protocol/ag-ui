const { dependencies } = require("./package.json");

// pnpm 10.33.4 drops resolution.path when it saves a GitHub tarball's
// integrity. Cold frozen installs then pack the repository root instead of
// building the selected package. Retain the subdirectory for our source pins.
// Remove this hook when pnpm preserves it or these pins become npm releases.
const sourcePins = [
  "@langchain/core",
  "@langchain/openai",
  "@langchain/langgraph",
].flatMap((name) => {
  const spec = dependencies[name];
  if (!spec?.startsWith("git+")) return [];
  const match =
    /^git\+https:\/\/github\.com\/([^#]+)\.git#([a-f0-9]{40})&path:(\/[^()]+)$/.exec(
      spec,
    );
  if (!match || match[3].split("/").includes("..")) {
    throw new Error(`Unsupported immutable source pin for ${name}: ${spec}`);
  }
  const [, repository, commit, path] = match;
  const tarball = `https://codeload.github.com/${repository}/tar.gz/${commit}`;
  return [{ key: `${name}@${tarball}#path:${path}`, tarball, path }];
});

module.exports = {
  hooks: {
    afterAllResolved(lockfile) {
      for (const [key, pkg] of Object.entries(lockfile.packages ?? {})) {
        const pin = sourcePins.find(
          ({ key: prefix }) => key === prefix || key.startsWith(`${prefix}(`),
        );
        if (!pin) continue;
        const resolution = pkg.resolution;
        if (
          resolution?.gitHosted !== true ||
          resolution.tarball !== pin.tarball
        ) {
          throw new Error(`Unexpected source resolution for ${key}`);
        }
        if (resolution.path !== undefined && resolution.path !== pin.path) {
          throw new Error(`Conflicting source subdirectory for ${key}`);
        }
        resolution.path = pin.path;
      }
      return lockfile;
    },
  },
};
