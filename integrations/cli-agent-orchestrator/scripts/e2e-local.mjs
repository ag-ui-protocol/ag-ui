#!/usr/bin/env node
// Local-only end-to-end check of the Dojo's Tool Approval page against a real
// cao-server and a real Claude Code agent. Run it through e2e-local.sh, which
// brings CAO and the Dojo up and tears them down. Not wired into CI: it needs
// a logged-in coding CLI on this machine.
//
//   node e2e-local.mjs approve   card appears; Approve writes approved-by-dojo.txt
//   node e2e-local.mjs reject    card appears; Reject leaves no file
//   node e2e-local.mjs none      nothing pending: the run still finishes, no card
//
// Every phase also asserts that each AG-UI run reaches RUN_FINISHED and that
// the chat leaves its running state within 15 s.
//
// Environment (e2e-local.sh sets these):
//   DOJO_URL        default http://localhost:3000
//   CAO_URL         default http://127.0.0.1:9889
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
if (!["approve", "reject", "none"].includes(phase)) {
  console.error("usage: node e2e-local.mjs <approve|reject|none>");
  process.exit(2);
}
const DOJO_URL = process.env.DOJO_URL ?? "http://localhost:3000";
const CAO_URL = process.env.CAO_URL ?? "http://127.0.0.1:9889";
const PAGE = `${DOJO_URL}/cli-agent-orchestrator/feature/tool_approval`;
const FILE = "approved-by-dojo.txt";
const LINE = "written after approval";
const SETTLE_MS = 15_000;

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${phase}: ${what}`);
  if (!ok) failures.push(what);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function caoStatus() {
  const res = await fetch(`${CAO_URL}/sessions/cao-agui-demo/terminals`);
  const [terminal] = await res.json();
  const t = await (await fetch(`${CAO_URL}/terminals/${terminal.id}`)).json();
  return t.status;
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
  r._run.end = Date.now();
  const body = (await (await r.response())?.text().catch(() => "")) ?? "";
  r._run.finished = body.includes('"type":"RUN_FINISHED"');
  r._run.outcome = body.match(/"outcome":\{"type":"(\w+)"/)?.[1] ?? null;
});

async function settled() {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    const streamsDone = runs.length > 0 && runs.every((r) => r.end);
    const running = await page.locator('[data-copilot-running="true"]').count();
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
    await box.press("Enter");
    const ok = await settled();
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
    const decideAt = runs.length;
    await page
      .getByTestId(phase === "approve" ? "approval-approve" : "approval-reject")
      .click();
    const ok = await settled();
    await shot("2-settled");
    check(
      ok,
      `every run finished and the chat left its running state within ${SETTLE_MS / 1000}s`,
    );
    check(
      runs.every((r) => r.finished),
      "every run reached RUN_FINISHED",
    );
    check(
      runs[decideAt]?.outcome === "success",
      "the resumed run finished with a success outcome",
    );

    const workdir = process.env.E2E_WORKDIR;
    if (check(Boolean(workdir), "E2E_WORKDIR is set")) {
      const file = join(workdir, FILE);
      if (phase === "approve") {
        let found = false;
        for (let i = 0; i < 120 && !found; i++) {
          found =
            existsSync(file) && readFileSync(file, "utf8").trim() === LINE;
          if (!found) await sleep(500);
        }
        check(found, `${FILE} exists and contains "${LINE}"`);
        await fileShot(file);
      } else {
        // Wait for the agent to finish its turn before checking nothing was written.
        let done = false;
        for (let i = 0; i < 120 && !done; i++) {
          done = ["completed", "idle"].includes(
            await caoStatus().catch(() => ""),
          );
          if (!done) await sleep(500);
        }
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
