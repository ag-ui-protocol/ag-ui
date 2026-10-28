import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../workflows/auto-approve-community.yml", import.meta.url),
  "utf8",
);
// Execute the actual inline script without introducing a YAML dependency.
const script = workflow.match(/^          script: \|\n((?:^ {12}.*\n|^\n)*)/m);
assert.ok(script, "missing auto-approval script");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const evaluate = new AsyncFunction(
  "github",
  "context",
  "core",
  "console",
  "Buffer",
  script[1].replace(/^ {12}/gm, ""),
);

const head = "a".repeat(40);
const newerHead = "b".repeat(40);
const base = "c".repeat(40);
const newerBase = "d".repeat(40);
const ownedFile = { filename: "sdks/community/go/owned.go" };
const unownedFile = { filename: ".github/workflows/publish-release.yml" };
const state = (sha = head, baseSha = base, ref = "main") => ({
  head: { sha },
  base: { sha: baseSha, ref },
});
const botReview = (commit_id = head) => ({
  id: 99,
  commit_id,
  state: "APPROVED",
  user: { login: "github-actions[bot]", type: "Bot" },
  body: "Auto-approved: PR author mattsp1290 has CODEOWNERS access to all changed files (excluding root rule)",
});

async function run({
  current = state(),
  after = current,
  reviews = [],
  pinnedFiles = [ownedFile],
  mutableFiles = pinnedFiles,
  compareError,
  dismissError,
} = {}) {
  const calls = [],
    approvals = [],
    dismissed = [],
    failures = [];
  let reads = 0;
  const github = {
    rest: {
      pulls: {
        listReviews() {},
        listFiles() {},
        async get() {
          calls.push("get");
          return { data: reads++ === 0 ? current : after };
        },
        async dismissReview({ review_id }) {
          calls.push("dismiss");
          if (dismissError) throw dismissError;
          dismissed.push(review_id);
        },
        async createReview(review) {
          approvals.push(review);
        },
      },
      repos: {
        async compareCommitsWithBasehead(params) {
          calls.push({ compare: params });
          if (compareError) throw compareError;
          return { data: { files: pinnedFiles } };
        },
        async getContent() {
          return {
            data: {
              content: Buffer.from(
                "* @ag-ui-protocol/copilotkit\nsdks/community/go @mattsp1290\n",
              ).toString("base64"),
            },
          };
        },
      },
    },
    async paginate(method) {
      if (method === github.rest.pulls.listReviews) {
        calls.push("reviews");
        return reviews;
      }
      if (method === github.rest.pulls.listFiles) {
        calls.push("mutable-files");
        return mutableFiles;
      }
      throw new Error("unexpected paginated endpoint");
    },
  };
  let error;
  try {
    await evaluate(
      github,
      {
        repo: { owner: "ag-ui-protocol", repo: "ag-ui" },
        payload: {
          repository: { default_branch: "main" },
          pull_request: {
            number: 1,
            user: { login: "mattsp1290" },
            ...state(),
          },
        },
      },
      { setFailed: (message) => failures.push(message) },
      { log() {} },
      Buffer,
    );
  } catch (caught) {
    error = caught;
  }
  return { calls, approvals, dismissed, failures, error };
}

test("A -> B -> A cannot approve A using B's owned files", async () => {
  const result = await run({
    pinnedFiles: [unownedFile],
    mutableFiles: [ownedFile],
  });
  assert.ifError(result.error);
  assert.equal(result.approvals.length, 0);
  assert.ok(!result.calls.includes("mutable-files"));
});

test("stale head event preserves the newer approval", async () => {
  const result = await run({
    current: state(newerHead),
    reviews: [botReview(newerHead)],
  });
  assert.ifError(result.error);
  assert.deepEqual(result.dismissed, []);
  assert.equal(result.approvals.length, 0);
});

for (const [name, current] of [
  ["base commit", state(head, newerBase)],
  ["base branch", state(head, base, "release")],
]) {
  test(`stale ${name} event leaves approvals intact`, async () => {
    const result = await run({ current, reviews: [botReview()] });
    assert.ifError(result.error);
    assert.deepEqual(result.dismissed, []);
    assert.equal(result.approvals.length, 0);
  });
}

test("owned diff uses immutable SHAs and withdraws only this workflow's approvals", async () => {
  const result = await run({
    reviews: [
      botReview(),
      { ...botReview(), id: 100, user: { login: "human", type: "User" } },
      { ...botReview(), id: 101, body: "Another workflow approved this PR" },
    ],
  });
  assert.ifError(result.error);
  assert.deepEqual(result.dismissed, [99]);
  assert.ok(result.calls.indexOf("get") < result.calls.indexOf("dismiss"));
  const comparison = result.calls.find((call) => call.compare)?.compare;
  assert.equal(comparison?.basehead, `${base}...${head}`);
  assert.equal(comparison?.page, 1);
  assert.equal(result.approvals.length, 1);
  assert.equal(result.approvals[0].commit_id, head);
});

for (const [name, files] of [
  ["empty diff", []],
  ["unowned path", [unownedFile]],
  [
    "rename out of unowned path",
    [{ ...ownedFile, previous_filename: unownedFile.filename }],
  ],
  ["backslash path", [{ filename: "sdks/community/go/unsafe\\file.go" }]],
  ["300-file comparison limit", Array.from({ length: 300 }, () => ownedFile)],
  ["missing file list", undefined],
]) {
  test(`refuses ${name}`, async () => {
    const result = await run({
      pinnedFiles: files === undefined ? null : files,
    });
    assert.ifError(result.error);
    assert.equal(result.approvals.length, 0);
  });
}

test("299 owned files can still be approved", async () => {
  const result = await run({
    pinnedFiles: Array.from({ length: 299 }, () => ownedFile),
  });
  assert.ifError(result.error);
  assert.equal(result.approvals.length, 1);
});

for (const [name, after] of [
  ["head", state(newerHead)],
  ["base commit", state(head, newerBase)],
  ["base branch", state(head, base, "release")],
]) {
  test(`refuses approval when ${name} changes during evaluation`, async () => {
    const result = await run({ after });
    assert.ifError(result.error);
    assert.equal(result.approvals.length, 0);
  });
}

test("comparison failure propagates without a new approval", async () => {
  const compareError = new Error("comparison unavailable");
  const result = await run({ compareError, reviews: [botReview()] });
  assert.equal(result.error, compareError);
  assert.deepEqual(result.dismissed, [99]);
  assert.equal(result.approvals.length, 0);
});

test("failed withdrawal fails the job without a new approval", async () => {
  const result = await run({
    dismissError: new Error("denied"),
    reviews: [botReview()],
  });
  assert.ifError(result.error);
  assert.equal(result.failures.length, 1);
  assert.equal(result.approvals.length, 0);
});
