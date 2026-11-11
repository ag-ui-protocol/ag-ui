# Verify the Codex contribution

Local verification used Linux arm64, Node.js 22.22.3, Codex SDK and CLI 0.167.1, and Flutter 3.47.1 with Dart 3.13.1.

The following checks passed.

- A frozen root dependency install.
- Nx package build, lint, typecheck, and 69 behavioral tests.
- Export validation and temporary installed ESM and CommonJS consumers.
- The installed standalone server started without repository sources or development dependencies.
- Existing AG-UI client tests passed, with 1,348 tests.
- Existing Claude SDK adapter tests passed, with 146 tests.
- Flutter's full example suite passed, with 59 tests.
- Flutter's web build and the web Dojo production build passed.
- Controlled browser scenarios proved two-turn chat in both clients and serial rendering of overlapping native replies in Flutter.
- A real provider run proved continuation, independent native conversations, and client cancellation. The server had no owned descendants after cleanup.

## Repeat the package checks

From the repository root, run the following commands.

```sh
pnpm install --frozen-lockfile
pnpm exec nx run-many -p @ag-ui/codex-sdk -t lint typecheck test test:exports test:packed --parallel=1
pnpm exec nx run-many -p @ag-ui/client @ag-ui/claude-agent-sdk -t test --parallel=1
```

`src/__tests__/adapter-cleanup.test.ts` uses real SDK processes. It checks process liveness at terminal delivery for delayed SIGTERM, malformed output, a SIGTERM-resistant child, and an orphan descendant retaining stdout. These checks establish cleanup before thread admission is released.

## Repeat the client checks

See [the example guide](../examples/README.md) to run either client against the standalone server. The source-only Codex job in `.github/workflows/dojo-e2e.yml` runs the browser scenarios and uploads Playwright traces. Published-package CI excludes this unreleased integration.

The Flutter tests preserve the Go default and drive `ClientToolsPageState` and `AgUiService` over HTTP with stable thread and assistant message IDs. `apps/dojo/e2e/tests/codexSdkTypescriptTests/` contains browser checks for both compiled clients.

## Keep provider evidence separate

`pnpm exec nx run @ag-ui/codex-sdk:smoke` requires the real server and host credentials. It checks native continuation and isolation, then cancels another request. Check process exit on the server host after cancellation. The controlled executable does not prove provider behavior.

## Limits of this run

Hosted GitHub Actions results are separate from these local checks. Flutter's full analysis reports the 41 inherited diagnostics documented by its existing README. The new endpoint and test files pass targeted analysis. Process supervision currently requires POSIX. Windows support and cross-platform live verification remain future work.
