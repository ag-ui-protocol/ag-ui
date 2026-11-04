import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { prepareCompleteEventTraceUpdates } from "./event-trace-update-completeness";
import {
  renderEventTraceModule,
  type EventTraceUpdateCandidate,
} from "./event-trace-update";

const goldenHelper = fileURLToPath(
  new URL("./event-trace-golden.ts", import.meta.url),
);
const events = [{ type: "RUN_STARTED" }];

async function createCapture(t: TestContext, placeholder = false) {
  const e2eRoot = await realpath(
    await mkdtemp(join(tmpdir(), "event-trace-completeness-")),
  );
  t.after(() => rm(e2eRoot, { recursive: true, force: true }));
  await writeFile(
    join(e2eRoot, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  const selectedLanes = ["typescript", "python"].map((id) => ({
    lane: { id },
    targets: ["chat", "tools"].map((name) => `tests/${id}/${name}.spec.ts`),
  }));
  const originals = new Map<string, string>();
  const candidates: EventTraceUpdateCandidate[] = [];
  for (const { lane, targets } of selectedLanes) {
    for (const target of targets) {
      const path = join(
        e2eRoot,
        target.replace(/\.spec\.ts$/, ".event-trace.ts"),
      );
      await mkdir(dirname(path), { recursive: true });
      const sourceUrl = pathToFileURL(path).href;
      const journeys = {
        first: placeholder ? [] : events,
        second: placeholder ? [] : events,
      };
      const content = await renderEventTraceModule({
        exportName: "trace",
        importPath: goldenHelper,
        reason: "initial",
        journeys,
      });
      await writeFile(path, content);
      originals.set(path, content);
      for (const journeyKey of Object.keys(journeys))
        candidates.push({
          lane: lane.id,
          sourceUrl,
          journeyKey,
          events: [{ type: "RUN_FINISHED" }],
        });
    }
  }
  async function publish(captured = candidates) {
    const updates = await prepareCompleteEventTraceUpdates({
      e2eRoot,
      selectedLanes,
      candidates: captured,
    });
    for (const update of updates) {
      await writeFile(
        fileURLToPath(update.sourceUrl),
        await renderEventTraceModule({
          exportName: "trace",
          importPath: goldenHelper,
          reason: "captured",
          journeys: update.journeys,
        }),
      );
    }
    return updates;
  }
  async function assertUnchanged() {
    for (const [path, content] of originals)
      assert.equal(await readFile(path, "utf8"), content);
  }
  async function appendToBaseline(sourceUrl: string, suffix: string) {
    const path = fileURLToPath(sourceUrl);
    const original = originals.get(path);
    assert.ok(original);
    const content = `${original}\n${suffix}\n`;
    await writeFile(path, content);
    originals.set(path, content);
  }
  return { candidates, publish, assertUnchanged, originals, appendToBaseline };
}

test("rejects an uncaptured malformed registered journey before changing any baseline", async (t) => {
  const capture = await createCapture(t);
  const final = capture.candidates.at(-1);
  assert.ok(final);
  await capture.appendToBaseline(final.sourceUrl, "trace.second[0] = {};");
  const partial = capture.candidates.filter((candidate) => candidate !== final);
  await assert.rejects(capture.publish(partial), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(`${final.sourceUrl}#second`));
    assert.match(error.message, /Invalid existing Event trace.*string type/s);
    return true;
  });
  await capture.assertUnchanged();
});

test("ignores unrelated exports and journeys registered to another source", async (t) => {
  const capture = await createCapture(t);
  const first = capture.candidates[0];
  assert.ok(first);
  await capture.appendToBaseline(
    first.sourceUrl,
    `export const unrelated = { values: [{}], label: "metadata" };
export const foreign = defineEventTrace(new URL("./other.event-trace.ts", import.meta.url).href, {
  other: [{}],
});`,
  );
  const updates = await capture.publish();
  assert.equal(updates.length, 4);
  for (const update of updates)
    assert.deepEqual(Object.keys(update.previous), ["first", "second"]);
});

for (const missing of ["journey", "spec"] as const) {
  test(`rejects a missing ${missing} in a later selected file before changing any baseline`, async (t) => {
    const capture = await createCapture(t);
    const final = capture.candidates.at(-1);
    assert.ok(final);
    const partial = capture.candidates.filter(
      (candidate) =>
        candidate.sourceUrl !== final.sourceUrl ||
        (missing === "journey" && candidate.journeyKey !== final.journeyKey),
    );
    await assert.rejects(
      capture.publish(partial),
      /Incomplete Event trace capture.*python.*tools.*second/s,
    );
    await capture.assertUnchanged();
  });
}

test("full capture updates every selected file and retains every journey", async (t) => {
  const capture = await createCapture(t);
  const updates = await capture.publish();
  assert.equal(updates.length, 4);
  for (const update of updates) {
    assert.deepEqual(Object.keys(update.journeys), ["first", "second"]);
    assert.deepEqual(Object.keys(update.previous), ["first", "second"]);
    assert.match(
      await readFile(fileURLToPath(update.sourceUrl), "utf8"),
      /RUN_FINISHED/,
    );
  }
});

test("new placeholder journeys can be populated by a complete first capture", async (t) => {
  const capture = await createCapture(t, true);
  const updates = await capture.publish();
  assert.equal(updates.length, 4);
  for (const update of updates) {
    assert.deepEqual(update.previous, { first: [], second: [] });
    assert.deepEqual(update.journeys, {
      first: [{ type: "RUN_FINISHED" }],
      second: [{ type: "RUN_FINISHED" }],
    });
  }
});

test("an extra candidate outside the selected lane/spec cannot enter publication", async (t) => {
  const capture = await createCapture(t);
  const first = capture.candidates[0];
  assert.ok(first);
  await assert.rejects(
    capture.publish([...capture.candidates, { ...first, lane: "unselected" }]),
    /outside the selected lane\/spec/,
  );
  await capture.assertUnchanged();
});
