# CopilotKit Demo Smoke Tests

This repository houses Playwright-based smoke tests that run on a 6-hour schedule to make sure CopilotKit demo apps remain live and functional.

## 🔧 Local development

```bash
# Install deps
npm install

# Install browsers once
npx playwright install --with-deps

# Run the full suite
npm test
```

Playwright HTML reports are saved to `./playwright-report`.

## ➕ Adding a new smoke test

1. Duplicate an existing file in `tests/` or create `tests/<demo>.spec.ts`.
2. Use Playwright's `test` API—keep the test short (<30 s).
3. Commit and push—GitHub Actions will pick it up on the next scheduled run.

## 🚦 CI / CD

- `.github/workflows/scheduled-tests.yml` executes the suite every 6 hours and on manual trigger.
- Failing runs surface in the Actions tab; the HTML report is uploaded as an artifact.
- (Optional) Slack notifications can be wired by adding a step after the tests.
- Slack alert on failure is baked into the workflow. Just add `SLACK_WEBHOOK_URL` (Incoming Webhook) in repo secrets.

## Strands event regression tests

The Python and TypeScript Strands journeys use `event-trace-test` to capture the
AG-UI events that reach the browser. Each `.event-trace.ts` file is a checked-in
baseline of an observed journey, including follow-up runs after frontend tools
and interrupts. Normal test runs compare against it and never update it. A
failure attaches the raw responses, normalized events, and expected events.

Start Dojo plus both Strands example servers with their OpenAI endpoint pointed
at the local aimock server (`http://localhost:5555/v1`, key `sk-mock`) and
`STRANDS_DEMO_FIXED_WEATHER=1`. The repository
`run-dojo-everything.js --only dojo,aws-strands,aws-strands-typescript` launcher
sets the fixed weather flag for both backends. Playwright
starts aimock with the existing deterministic fixtures. Use Node 22 for the
browser runner. From this directory, capture or intentionally update a journey:

```sh
BASE_URL=http://localhost:9999 pnpm event-trace:update \
  --integration strands --spec agenticChatPage \
  --reason "Explain the intended event behavior change"
```

The updater runs both Strands languages and only writes baselines after both
succeed. Omit `--integration` to retain the existing LangGraph update workflow.
`--all` captures all specs with event-trace companions in the selected integration. Review event order,
payloads, and run boundaries before accepting any baseline update; a changed
baseline can indicate a bridge regression. Every selected companion file and
every existing journey key must produce a candidate in its matching lane before
any baseline is written. Skipped specs or partial captures fail the update. To
remove a journey deliberately, edit both its baseline entry and test source
explicitly; skipping a test is not a baseline-removal mechanism.

To add coverage, import `test` from `event-trace-test`, create a companion
`defineEventTrace(import.meta.url, { descriptiveJourneyName: [] })`, and call
`await eventTrace.expectJourney(trace.descriptiveJourneyName)` after the journey
has finished. Run the update command above with the new spec name, then rerun
without update mode:

```sh
BASE_URL=http://localhost:9999 pnpm exec playwright test \
  tests/awsStrandsTests/agenticChatPage.spec.ts \
  tests/awsStrandsTypescriptTests/agenticChatPage.spec.ts --workers=1
```

These are captured browser contracts for each bridge. They reuse the existing
Dojo normalization rules; they do not establish that the two raw bridge streams
are identical or replace PNI-351's proposed shared bridge-input corpus.

Current Strands coverage: 34 journeys across chat, reasoning, backend tools,
frontend tools, human-in-the-loop, native interrupts, shared state, and
multi-agent handoffs. Navigation waits for initial requests to settle before
sending a message, and interrupt tests fix the browser date and timezone so the
chosen meeting time remains part of the checked payload.

Predictive-state journeys retain their existing tests. An attempted event
baseline exposed a shared-editor lifecycle bug: after the frontend tool halts,
the editor can retain a partial draft and echo that partial text back in the next
`RUN_STARTED.input.state.document`. A repeated capture had the same event count
but different document text. Waiting for the full draft can time out with only
“Once upon a time, in a land far away,” rendered. Rejection can also concatenate
the old and new names. Fix the editor lifecycle before adding these two journeys
per language to the event baselines; do not normalize away document content.

For concurrent local runs, use a dedicated Dojo port and set `AIMOCK_PORT` on the
browser command and the matching `OPENAI_BASE_URL` on both Strands backends.
Each update invocation keeps its candidates and temporary golden files in its
own directory beneath `.event-trace-update/`. Before publishing, the updater backs
up every original baseline. If a replacement fails, it restores earlier replacements
and removes the invocation directory. If restoration also fails, the error reports
both failures and the retained directory: use its `recovery.json` mapping to copy
each `backupPath` over its baseline `path` (or delete `path` when `backupPath` is
`null`, meaning the baseline did not previously exist), then remove the directory
and retry.
Successful updates also remove the invocation directory. Captures can overlap,
but a second invocation attempting to publish while another is writing golden
files fails and must be rerun.

Each replacement is atomic, but the batch is not crash-atomic or power-loss durable.
A forced termination can leave a partially updated batch, recovery files, and
`.event-trace-update/publish.lock`. Confirm no update is still publishing, restore
the originals using that run's `recovery.json` if publication began, and remove
the stale lock before retrying. Do not delete recovery files before restoring.
