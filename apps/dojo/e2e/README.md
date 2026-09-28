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

All 29 event-instrumented LangGraph specs select separate V2 references with
`LANGGRAPH_TRACE_REFERENCE=v2`. This selects the reference only; the Dojo server
controls the protocol. Both lanes use the same comparator and normalization.

| Suite                         | Specs | Recorded journeys | Runtime                                 |
| ----------------------------- | ----: | ----------------: | --------------------------------------- |
| Python                        |    14 |                27 | LangGraph Platform                      |
| TypeScript                    |    14 |                29 | LangGraph Platform                      |
| TypeScript deterministic chat |     1 |                 1 | MockAgent (UI contract only)            |
| Total                         |    29 |                57 | 56 Platform journeys and 1 mock journey |

Coverage includes chat, V1 chat, reasoning, multimodal, human-in-the-loop,
predictive and shared state, tool-based and agentic generative UI, subgraphs,
A2UI fixed/dynamic/advanced, Python backend tools, and TypeScript A2UI recovery.
Advanced A2UI uses the dynamic-schema graph; V1 chat uses the chat graph.
Playwright discovers 62 tests: 59 active and three pre-existing unsupported
GUI-regeneration skips, which contain no `expectJourney` assertion. Those skips
are not transformer parity coverage.

Reproduce the locked CI environment from the repository root with the repository's
Node version, pnpm 10.33.4, Python 3.12, and uv installed. The pnpm store must be
outside any `node_modules` directory: Node cannot load the upstream TypeScript
build configs there. CI sets its store to `$RUNNER_TEMP/pnpm-store`.

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/dojo/e2e install --ignore-workspace --frozen-lockfile --ignore-scripts
pnpm --dir integrations/langgraph/typescript/examples install --ignore-workspace --frozen-lockfile
uv sync --frozen --project integrations/langgraph/python/examples
projects=$(node -p 'Object.keys(require("./apps/dojo/package.json").dependencies).filter(name => name.startsWith("@ag-ui/")).join(",")')
pnpm exec nx run-many -t build --projects="$projects"
pnpm --dir apps/dojo/e2e exec playwright install chromium
touch integrations/langgraph/python/examples/.env
touch integrations/langgraph/typescript/examples/.env
node --test apps/dojo/e2e/scripts/langgraph-parity-ci.test.mjs
node apps/dojo/e2e/scripts/langgraph-parity-ci.mjs v2 &&
node apps/dojo/e2e/scripts/langgraph-parity-ci.mjs v3
```

The runner starts and stops both Platform servers, Dojo, and aimock, discovers
all 29 instrumented specs, and uses the same committed V2 references in both
lanes. The V3 command runs only after the V2 control succeeds. Logs and browser
artifacts are under `apps/dojo/e2e/test-results/langgraph-parity-{v2,v3}`. The
TypeScript CLI comes from the frozen examples dependency lockfile; use this
runner rather than an unpinned `pnpx` invocation.

Both `langgraph.transformer.json` files cover every graph in their ordinary
Platform configs: 13 Python and 12 TypeScript graphs. Python additionally
registers deepagents, which has no Platform browser journey. TypeScript wrappers
preserve existing transformer factories and add the real AG-UI transformer only
when absent, avoiding duplicate transformation.

The PR check **Forced V2 then actual transformer V3** records the complete
result for each commit. Both lanes must pass every active test against the same
references; a passing V2 control alone does not establish transformer parity.
Local investigation captures stay outside the repository.

The V2 references started from historical commit
`40284a07ad184eddc7fc77bda8fa23ff64398af9`. The control refreshed 34 journeys from
reviewed forced-V2 captures using the committed runtime locks and production SDK
source pin below, followed by an independent green replay. All 29 reference files
are verified against that control; none were generated from transformer V3.
Default references remain separate because some came from raw V3.
After the Responses provider fix, an independent forced-V2 recapture verified
exactly one further normalized change in TypeScript reasoning: the completed
model name appears once instead of twice. Every other field was identical, and
the corrected reference passed a separate forced-V2 replay.

To replay or update a V2 reference, restart Dojo with
`LANGGRAPH_STREAM_PROTOCOL_FOR_TESTS=v2` and **unset**
`LANGGRAPH_EVENT_SOURCE_FOR_TESTS`. Keep `LANGGRAPH_TRACE_REFERENCE=v2` on the
browser process. Never update V2 references from a transformer run. The forced
transformer setting fails if V3 subscription fails or raw V3 events arrive.

The Python examples use CopilotKit SDK 0.1.96 from immutable source commit
`53110f119632dc6b99583893294413f88a5c00d3` (`sdk-python`), containing the production
middleware context fix in [CopilotKit PR #7449](https://github.com/CopilotKit/CopilotKit/pull/7449).
This production fix has not been released: the ordinary published 0.1.96 package
does not contain it. `uv sync --frozen --project integrations/langgraph/python/examples`
is required to resolve the committed source pin. Bare Poetry installs or ad hoc
`pnpx` launch commands may ignore that uv source configuration and run a different
environment. Replace the source pin with a published package containing the fix
when available. The parity suite does not substitute a test-only context shim.

The lane also pins production streaming fixes that are not yet released:

- TypeScript LangGraph commit `8767630e40b27680f67cfaca6f7e79ff3e0a48c0`
  ([LangGraph.js PR #2891](https://github.com/langchain-ai/langgraphjs/pull/2891))
  forwards custom callbacks, preserves message metadata and class-safe payload
  snapshots, and identifies returned node messages without buffering live model
  tokens. Optional task return-type provenance distinguishes plain state updates
  from `Command` carriers before channel writes erase that distinction. The global example override
  makes `langchain.createAgent` use the same source. Scoped SDK/checkpoint overrides
  resolve monorepo workspace ranges during Git-source installation.
- Python LangGraph commit `51abe90118682f8c2ca6150b3d68fb920529578b`
  ([LangGraph PR #9079](https://github.com/langchain-ai/langgraph/pull/9079))
  snapshots native protocol frames before queueing and preserves optional task
  return-type provenance. A transformer cannot infer a plain dictionary return
  from channel writes alone; absent provenance is treated conservatively.
- Python LangChain Core commit `e9b3bb830dd5c8566d63c4fa354a0cd853af8441`
  ([LangChain PR #40842](https://github.com/langchain-ai/langchain/pull/40842))
  retains provider text/reasoning block IDs at stream start.
- TypeScript LangChain Core and OpenAI commit
  `ec6278b6b9a7ff23a0553bdf91150ad9b57fbbff`
  ([LangChain.js PR #11732](https://github.com/langchain-ai/langchainjs/pull/11732))
  preserves Responses provider metadata, original content indices, and message
  additional kwargs. It also fixes V2's duplicated final model name: the created
  event retains early `model_name`, and the completed response supplies `model`
  once. Source package build hooks make the immutable Git installs reproducible.

These are fixes in the production packages, not example-only runtime patches.
The TypeScript examples' `.pnpmfile.cjs` preserves the source package subdirectory
in the lockfile: pnpm 10.33.4 otherwise drops it when recording GitHub tarball
integrity, causing cold frozen installs to package the repository root. The hook
is limited to these three immutable source dependencies and can be removed when
they use published releases or pnpm preserves the path itself. CI checks their
built entry points before starting the browser lanes.
The source pins make validation reproducible; they do not mean the fixes have
reached ordinary registry installs. Replace them with releases containing the
fixes before claiming parity for those released dependencies.

TypeScript prediction hints remain explicit transformer options for compatibility
with runtimes that omit callback metadata. The pinned runtime also preserves the
original metadata. Internal transformer completion markers are consumed by the
adapter to drain final snapshots before subscription reuse; they never reach the
browser.
