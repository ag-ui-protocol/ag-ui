#!/usr/bin/env node
// Local-only end-to-end check of the Dojo's Tool Approval page against a real
// cao-server and a real Claude Code agent. Run it through e2e-local.sh, which
// brings CAO and the Dojo up and tears them down. Not wired into CI: it needs
// a logged-in coding CLI on this machine.
//
//   node e2e-local.mjs approve   card appears; Approve writes approved-by-dojo.txt
//   node e2e-local.mjs reject    card appears; Reject leaves no file
//   node e2e-local.mjs none      nothing pending: the run still finishes, no card
//   node e2e-local.mjs retry     card appears; the first answer is dropped on its
//                                way to CAO, so the card must stay with a "Not
//                                delivered" notice; answering again resumes the
//                                same interrupt and writes the file
//   node e2e-local.mjs retry-response
//                                card appears; the first answer REACHES CAO but
//                                its response is dropped before the page sees
//                                it: the card stays with the answer locked, and
//                                answering again resends that same answer, the
//                                run finishes and the file exists
//
// Every phase also asserts that each AG-UI run reaches RUN_FINISHED and that
// the chat leaves its running state within 15 s.
//
// Environment (e2e-local.sh sets these):
//   DOJO_URL        default http://127.0.0.1:3000
//   CAO_URL         default http://127.0.0.1:9898
//   E2E_SESSION     the CAO session name, e.g. cao-agui-demo-ab12cd
//   E2E_WORKDIR     the agent's work dir (approve/reject check the file there)
//   E2E_VIDEO_DIR   opt-in: record a video of the page into this dir
//   E2E_CAPTION     opt-in: caption drawn on the page, e.g. the CAO build
//   E2E_SHOT_DIR    opt-in: save screenshots of each step into this dir
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { caoStatus, pollUntil } from "./cao-poll.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dojoE2e = join(here, "../../../apps/dojo/e2e");
let chromium;
try {
  ({ chromium } = createRequire(join(dojoE2e, "package.json"))(
    "@playwright/test",
  ));
} catch {
  console.error(
    "e2e-local: the Dojo's Playwright is not installed. Run:\n" +
      "  (cd apps/dojo/e2e && pnpm install --ignore-scripts && npx playwright install chromium)",
  );
  process.exit(2);
}

const phase = process.argv[2];
if (!["approve", "reject", "none", "retry", "retry-response"].includes(phase)) {
  console.error(
    "usage: node e2e-local.mjs <approve|reject|none|retry|retry-response>",
  );
  process.exit(2);
}
const DOJO_URL = process.env.DOJO_URL ?? "http://127.0.0.1:3000";
const CAO_URL = process.env.CAO_URL ?? "http://127.0.0.1:9898";
const PAGE = `${DOJO_URL}/cli-agent-orchestrator/feature/tool_approval`;
const FILE = "approved-by-dojo.txt";
const LINE = "written after approval";
const SETTLE_MS = 15_000;
// Wall-clock budget for the file and agent-status polls (was 120 tries x 500 ms).
const POLL_MS = 60_000;

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const failures = [];
let retryCheck = () => {};
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${phase}: ${what}`);
  if (!ok) failures.push(what);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The resume[] entries inside a runtime request body, wherever the runtime
// wraps the run input. Each is { interruptId, status, payload }.
function resumeEntries(body) {
  const find = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = find(item);
        if (found) return found;
      }
      return undefined;
    }
    if (value && typeof value === "object") {
      if (Array.isArray(value.resume)) return value.resume;
      for (const item of Object.values(value)) {
        const found = find(item);
        if (found) return found;
      }
    }
    return undefined;
  };
  try {
    return find(JSON.parse(body)) ?? [];
  } catch {
    return [];
  }
}
const decisionOf = (entries) =>
  JSON.stringify(
    entries
      .map((e) => [e.interruptId, e.payload?.approved])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );

// The interrupt ids a run's response lists in RUN_FINISHED.result.skippedResume.
// A skipped answer was not applied, so it must not count as "CAO acted".
function skippedIds(responseText) {
  const ids = [];
  for (const line of responseText.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5));
      if (event?.type === "RUN_FINISHED")
        for (const e of event.result?.skippedResume ?? [])
          if (typeof e?.interruptId === "string") ids.push(e.interruptId);
    } catch {
      // not a JSON event line
    }
  }
  return ids;
}

const browser = await chromium.launch();
const videoDir = process.env.E2E_VIDEO_DIR;
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  ...(videoDir
    ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } }
    : {}),
});
const caption = process.env.E2E_CAPTION;
if (caption) {
  const text = `${caption} | ${phase}`;
  await context.addInitScript((t) => {
    const draw = () => {
      if (document.getElementById("e2e-caption")) return;
      const el = document.createElement("div");
      el.id = "e2e-caption";
      el.textContent = t;
      el.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:6px 12px;" +
        "font:14px/1.4 monospace;background:#111;color:#fff;pointer-events:none";
      document.body.appendChild(el);
    };
    if (document.body) draw();
    else document.addEventListener("DOMContentLoaded", draw);
  }, text);
}
const page = await context.newPage();

const shotDir = process.env.E2E_SHOT_DIR;
if (shotDir) mkdirSync(shotDir, { recursive: true });
// Screenshot the page (or, for the file check, a plain view of the file).
async function shot(name) {
  if (!shotDir) return;
  await page
    .screenshot({ path: join(shotDir, `${phase}-${name}.png`) })
    .catch((e) =>
      console.log(`screenshot ${name} failed: ${e.message.split("\n")[0]}`),
    );
}
async function fileShot(file) {
  if (!shotDir) return;
  const view = await context.newPage();
  const body = existsSync(file)
    ? `${FILE}  (${statSync(file).size} bytes)\n\n${readFileSync(file, "utf8")}`
    : `${FILE}: no such file`;
  const caption = process.env.E2E_CAPTION ?? "";
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  await view.setContent(
    `<pre style="font:18px/1.5 monospace;padding:24px">${caption ? `${esc(caption)} | ${phase}\n\n` : ""}` +
      `$ cat &lt;agent work dir&gt;/${FILE}\n${esc(body)}</pre>`,
  );
  await view
    .screenshot({ path: join(shotDir, `${phase}-3-file.png`) })
    .catch(() => {});
  await view.close();
}

// Every AG-UI run the page starts, with its outcome once its stream ends.
const runs = [];
page.on("request", (r) => {
  if (
    r.url().includes("/api/copilotkit") &&
    (r.postData() ?? "").includes('"agent/run"')
  ) {
    r._run = { start: Date.now(), end: null, finished: false, outcome: null };
    runs.push(r._run);
  }
});
page.on("requestfinished", async (r) => {
  if (!r._run) return;
  // Publish `end` only after the body is inspected: settled() treats a run
  // with an end time as done, and the checks after it read finished/outcome.
  // If the body cannot be read the run stays unfinished, with no outcome.
  try {
    const body = (await (await r.response())?.text()) ?? "";
    r._run.finished = body.includes('"type":"RUN_FINISHED"');
    r._run.skipped = skippedIds(body);
    r._run.outcome = body.match(/"outcome":\{"type":"(\w+)"/)?.[1] ?? null;
  } catch {
    r._run.finished = false;
    r._run.outcome = null;
  } finally {
    r._run.end = Date.now();
  }
});

// The one request the retry phase drops on purpose. Every other request must
// reach RUN_FINISHED, so a request that fails for any other reason is a failure.
const droppedRequests = new Set();

// A request that fails outright ends its run without RUN_FINISHED.
page.on("requestfailed", (r) => {
  if (!r._run) return;
  r._run.dropped = droppedRequests.has(r);
  r._run.finished = false;
  r._run.outcome = null;
  r._run.failed = true;
  r._run.end = Date.now();
});

// With `since`, at least one run must have started at or after that time, so an
// earlier run that ended before the decision's own request was recorded cannot
// satisfy it. A deliberately dropped request ends through `requestfailed`, so it
// counts as ended like any other run.
async function settled(since = 0) {
  // The budget runs from the submission, not from when this call starts.
  const deadline = (since || Date.now()) + SETTLE_MS;
  while (Date.now() < deadline) {
    const running = await page.locator('[data-copilot-running="true"]').count();
    // The DOM read can take time: re-check the deadline before succeeding.
    if (Date.now() > deadline) return false;
    // Read the runs after the awaited DOM read, so the snapshot is not stale.
    const streamsDone =
      runs.length > 0 &&
      runs.some((r) => r.start >= since) &&
      runs.every((r) => r.end);
    if (streamsDone && running === 0) return true;
    await sleep(250);
  }
  return false;
}

try {
  const ready = page.waitForResponse(
    (r) => r.url().includes("/api/copilotkit") && r.status() === 200,
    { timeout: 180_000 },
  );
  await page.goto(PAGE, { timeout: 180_000 });
  await ready;
  await sleep(1500);
  const box = page.getByRole("textbox").first();
  const card = page.getByTestId("approval-card");

  if (phase === "none") {
    await box.fill("Is anything waiting for my approval?");
    const sentAt = Date.now();
    await box.press("Enter");
    const ok = await settled(sentAt);
    await shot("2-settled");
    check(
      ok,
      `the run finished and the chat left its running state within ${SETTLE_MS / 1000}s`,
    );
    check(
      runs.length === 1 && runs[0].finished && runs[0].outcome === "success",
      "RUN_FINISHED with a success outcome",
    );
    check((await card.count()) === 0, "no approval card");
  } else {
    // The prompt is up in the pane (e2e-local.sh waits for it), but CAO may
    // take a moment to classify it, so ask up to three times.
    let shown = false;
    for (let attempt = 1; attempt <= 3 && !shown; attempt++) {
      const before = runs.length;
      await box.fill("Is anything waiting for my approval?");
      await box.press("Enter");
      shown = await card.waitFor({ timeout: SETTLE_MS }).then(
        () => true,
        () => false,
      );
      if (!shown) {
        const run = runs[before];
        if (!run?.end) break; // the run never finished: no point asking again
        await sleep(3000);
      }
    }
    if (!check(shown, "the approval card appeared")) throw new Error("no card");
    console.log(`${at()} card: ${JSON.stringify(await card.innerText())}`);
    await shot("1-card");
    if (phase === "retry" || phase === "retry-response") {
      const dropResponse = phase === "retry-response";
      // retry: drop the first resume request (the one that carries an
      // interruptId) on its way to the Dojo's runtime route, as a CAO outage
      // would. CAO never sees it, so its interrupt stays open and the same id
      // can be answered. retry-response: let it reach CAO, then drop the
      // response, so CAO has already acted when the page reports a failure.
      // A restarted cao-server could not honour that id: its interrupts are
      // held in memory.
      let dropped = 0;
      let dropping = true;
      let droppedBody;
      let retryBody;
      await page.route("**/api/copilotkit/**", async (route) => {
        const body = route.request().postData() ?? "";
        if (
          !dropping &&
          retryBody === undefined &&
          droppedBody !== undefined &&
          body.includes('"interruptId"')
        )
          retryBody = body;
        if (dropping && body.includes('"interruptId"')) {
          droppedBody = body;
          dropped++;
          dropping = false;
          droppedRequests.add(route.request());
          if (dropResponse) {
            // Let the request reach CAO, and wait for the answer to come back,
            // then fail it before the page sees the result. CAO has acted.
            // The answer only counts as delivered if CAO's run finished with a
            // success outcome; a fetch error or any other response is a
            // recorded failure, so this phase cannot pass without testing a
            // replay after CAO has acted.
            let delivered = false;
            let detail = "no response";
            try {
              const response = await route.fetch();
              const text = await response.text();
              const submitted = resumeEntries(body).map((e) => e.interruptId);
              const skipped = skippedIds(text).filter((id) =>
                submitted.includes(id),
              );
              delivered =
                text.includes('"type":"RUN_FINISHED"') &&
                /"outcome":\{"type":"success"/.test(text) &&
                skipped.length === 0;
              detail =
                skipped.length > 0
                  ? `CAO skipped the answer for ${skipped.join(", ")}`
                  : `status ${response.status()}, no RUN_FINISHED success outcome`;
            } catch (error) {
              detail = `fetch failed: ${error?.message ?? error}`;
            }
            check(
              delivered,
              `the first resume reached CAO and finished with a success outcome before its response was dropped (${delivered ? "ok" : detail})`,
            );
          }
          return route.abort("failed");
        }
        return route.continue();
      });
      await page.getByTestId("approval-approve").click();
      const notice = page.getByTestId("approval-error");
      const shownNotice = await notice.waitFor({ timeout: SETTLE_MS }).then(
        () => true,
        () => false,
      );
      check(
        dropped === 1,
        dropResponse
          ? "the first resume response was dropped"
          : "the first resume request was dropped",
      );
      check(shownNotice, "a Delivery unconfirmed notice appeared");
      check(
        shownNotice &&
          (await notice.innerText()).includes("Delivery unconfirmed"),
        'the notice says "Delivery unconfirmed"',
      );
      check((await card.count()) === 1, "the approval card stayed");
      check(
        await page.getByTestId("approval-approve").isEnabled(),
        "Approve is enabled again",
      );
      const answerNote = page.getByTestId("approval-answer");
      check(
        (await answerNote.count()) === 1 &&
          (await answerNote.innerText()).includes(
            "may already have reached the agent",
          ),
        "the card says the sent answer is locked and may have reached the agent",
      );
      check(
        await page.getByTestId("approval-reject").isDisabled(),
        "Reject is disabled: the sent answer cannot be changed",
      );
      if (!dropResponse)
        check(
          !existsSync(join(process.env.E2E_WORKDIR ?? "", FILE)),
          `${FILE} was not written by the dropped answer`,
        );
      await shot("1b-not-delivered");
      dropping = false;
      retryCheck = () => {
        // The decision stands on the two request bodies: the retry must resend
        // the same interrupt id(s) with the same approved value(s) as the
        // request that was dropped.
        const first = resumeEntries(droppedBody ?? "");
        const again = resumeEntries(retryBody ?? "");
        check(
          first.length > 0 &&
            first.every(
              (e) =>
                e.status === "resolved" &&
                typeof e.payload?.approved === "boolean",
            ),
          `the dropped request carried a resume answer (${decisionOf(first)})`,
        );
        check(
          again.length > 0 &&
            again.every((e) => e.status === "resolved") &&
            decisionOf(again) === decisionOf(first),
          `the retry repeated the dropped request's interruptId and approved value (${decisionOf(first)} vs ${decisionOf(again)})`,
        );
      };
    }
    const decideAt = runs.length;
    const decisionAt = Date.now();
    await page
      .getByTestId(phase === "reject" ? "approval-reject" : "approval-approve")
      .click();
    const ok = await settled(decisionAt);
    await shot("2-settled");
    check(
      ok,
      `every run finished and the chat left its running state within ${SETTLE_MS / 1000}s`,
    );
    check(
      runs.every((r) => r.finished || r.dropped),
      "every run reached RUN_FINISHED (only the deliberately dropped request excepted)",
    );
    check(
      runs.every((r) => r.dropped || (r.end && r.end - r.start <= SETTLE_MS)),
      `each run ended within ${SETTLE_MS / 1000}s of its own start (the dropped request excepted)`,
    );
    check(
      runs.slice(decideAt).every((r) => !r.skipped?.length),
      "CAO skipped none of the answers the decision run submitted",
    );
    retryCheck();
    check(
      runs[decideAt]?.outcome === "success",
      "the resumed run finished with a success outcome",
    );
    if (phase.startsWith("retry"))
      check((await card.count()) === 0, "the card is gone once delivered");

    const workdir = process.env.E2E_WORKDIR;
    if (check(Boolean(workdir), "E2E_WORKDIR is set")) {
      const file = join(workdir, FILE);
      if (phase !== "reject") {
        const found = await pollUntil(
          () => existsSync(file) && readFileSync(file, "utf8").trim() === LINE,
          POLL_MS,
        );
        check(found, `${FILE} exists and contains "${LINE}"`);
        await fileShot(file);
      } else {
        // Wait for the agent to finish its turn before checking nothing was written.
        const done = await pollUntil(
          async () =>
            ["completed", "idle"].includes(
              await caoStatus(CAO_URL, process.env.E2E_SESSION),
            ),
          POLL_MS,
        );
        check(done, "the agent finished its turn");
        check(!existsSync(file), `${FILE} was not created`);
        await fileShot(file);
      }
    }
  }
} catch (error) {
  if (!failures.length)
    check(false, `driver error: ${error.message.split("\n")[0]}`);
} finally {
  if (failures.length) await shot("9-failed");
  console.log(
    `${at()} runs: ` +
      JSON.stringify(
        runs.map((r) => ({
          ms: r.end ? r.end - r.start : null,
          finished: r.finished,
          outcome: r.outcome,
        })),
      ),
  );
  // Closing flushes the video. Don't let a dead browser hide the verdict.
  const video = page.video();
  await context.close().catch(() => {});
  // Name the recording after the phase instead of Playwright's random id.
  if (video) {
    await video
      .path()
      .then((p) => renameSync(p, join(videoDir, `${phase}.webm`)))
      .catch(() => {});
  }
  await browser.close().catch(() => {});
}

console.log(
  failures.length ? `FAIL ${phase} (${failures.length})` : `PASS ${phase}`,
);
process.exit(failures.length ? 1 : 0);
