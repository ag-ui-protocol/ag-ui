const assert = require("node:assert/strict");
const { test } = require("node:test");
const { hooks } = require("./.pnpmfile.cjs");
const { dependencies } = require("./package.json");

function source(name) {
  const [, repo, commit, path] =
    /^git\+https:\/\/github\.com\/([^#]+)\.git#([^&]+)&path:(.+)$/.exec(
      dependencies[name],
    );
  const tarball = `https://codeload.github.com/${repo}/tar.gz/${commit}`;
  return { key: `${name}@${tarball}#path:${path}`, tarball, path };
}

test("retains the subdirectory and integrity for all immutable source packages", () => {
  for (const name of [
    "@langchain/core",
    "@langchain/openai",
    "@langchain/langgraph",
  ]) {
    const { key, tarball, path } = source(name);
    for (const suffix of ["", "(@peer/package@1.0.0)"]) {
      const resolution = {
        gitHosted: true,
        tarball,
        integrity: "sha512-existing",
      };
      const lock = { packages: { [`${key}${suffix}`]: { resolution } } };
      assert.equal(hooks.afterAllResolved(lock), lock);
      assert.deepEqual(resolution, {
        gitHosted: true,
        tarball,
        integrity: "sha512-existing",
        path,
      });
      hooks.afterAllResolved(lock);
      assert.equal(resolution.path, path);
    }
  }
});

test("leaves unrelated packages unchanged", () => {
  const lock = {
    packages: {
      "other@https://codeload.github.com/other/repo/tar.gz/abc#path:/package": {
        resolution: {
          gitHosted: true,
          tarball: "https://codeload.github.com/other/repo/tar.gz/abc",
        },
      },
      "ordinary@1.0.0": { resolution: { integrity: "sha512-ordinary" } },
    },
  };
  const before = structuredClone(lock);
  hooks.afterAllResolved(lock);
  assert.deepEqual(lock, before);
});

test("rejects conflicting source resolutions", () => {
  const { key, tarball } = source("@langchain/langgraph");
  assert.throws(
    () =>
      hooks.afterAllResolved({
        packages: {
          [key]: { resolution: { gitHosted: true, tarball, path: "/wrong" } },
        },
      }),
    /Conflicting source subdirectory/,
  );
  assert.throws(
    () =>
      hooks.afterAllResolved({
        packages: {
          [key]: {
            resolution: { gitHosted: true, tarball: "https://wrong.example" },
          },
        },
      }),
    /Unexpected source resolution/,
  );
});
