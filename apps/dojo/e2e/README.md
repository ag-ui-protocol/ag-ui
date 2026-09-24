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

### LangGraph V2 and transformer parity

The six LangGraph chat, human-in-the-loop, and tool-based UI specs can compare
against separate V2 references by setting `LANGGRAPH_TRACE_REFERENCE=v2` on the
Playwright process. This selects the reference only; the Dojo server controls
which protocol actually runs. The comparator and payload normalization are the
same for both lanes.

Start the Python and TypeScript example Platform servers with their respective
`langgraph.transformer.json` files. These register all three graphs with the
actual AG-UI transformer. Point both servers' `OPENAI_BASE_URL` at the aimock
port used by Playwright (for example, `http://localhost:15555/v1`). Then start
Dojo with these environment variables:

```sh
LANGGRAPH_STREAM_PROTOCOL_FOR_TESTS=v3 \
LANGGRAPH_EVENT_SOURCE_FOR_TESTS=transformer \
LANGGRAPH_PYTHON_URL=http://localhost:18005 \
LANGGRAPH_TYPESCRIPT_URL=http://localhost:18006 \
pnpm --dir apps/dojo exec next dev --port 19999
```

From the repository root, run the existing browser journeys:

```sh
BASE_URL=http://localhost:19999 AIMOCK_PORT=15555 LANGGRAPH_TRACE_REFERENCE=v2 \
pnpm --dir apps/dojo/e2e exec playwright test \
  tests/langgraphPythonTests/agenticChatPage.spec.ts \
  tests/langgraphPythonTests/humanInTheLoopPage.spec.ts \
  tests/langgraphPythonTests/toolBasedGenUIPage.spec.ts \
  tests/langgraphTypescriptTests/agenticChatPage.spec.ts \
  tests/langgraphTypescriptTests/humanInTheLoopPage.spec.ts \
  tests/langgraphTypescriptTests/toolBasedGenUIPage.spec.ts --workers=1
```

This covers 14 active journeys: greeting, frontend tool continuation/reset,
five-turn memory, two interrupt/resume journeys, and single- and two-prompt
haiku generation in each language. Two existing regeneration tests remain
skipped and are not part of this parity claim. The forced transformer setting
fails if V3 subscription fails or the adapter receives raw V3 events instead.

The `v2/` references start from historical commit `40284a07` and were replayed
through **forced V2**, independently of transformer output. The TypeScript
control used LangGraph 1.3.0, Core 1.1.46, SDK 1.9.2, OpenAI 1.2.0, LangChain
1.2.8, and CopilotKit SDK 1.57.1; Python used LangGraph 1.2.10, API 0.14.4,
LangChain 1.3.14, and CopilotKit 0.1.86. The control established current terminal
usage, frontend tool descriptions, and V2 state boundaries. Default references
remain separate because some were captured using raw V3.

To replay or update a V2 reference, restart Dojo with
`LANGGRAPH_STREAM_PROTOCOL_FOR_TESTS=v2` and **unset**
`LANGGRAPH_EVENT_SOURCE_FOR_TESTS`. Use the same `LANGGRAPH_TRACE_REFERENCE=v2`
browser selection. Never update these references from a transformer run.

LangGraph's TypeScript V3 conversion currently omits callback `predict_state`
metadata. The human-in-the-loop example shares its prediction configuration
with `aguiTransformer({ predictState })` so the transformer preserves predictive
state behavior. Python retains that metadata on the messages channel. Internal
transformer completion markers are consumed by the adapter to drain final
snapshots before reusing a subscription; they never reach the browser.
