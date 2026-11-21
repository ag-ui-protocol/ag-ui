# Changelog

## 0.0.4 — 2026-10-26

- Added `WatsonxRunsAgent` for the `/v1/orchestrate/runs/stream` endpoint, surfacing run steps and raw tool responses as `TOOL_CALL_*` events.
- Added optional `onToolResult` hook that emits tool responses as `STATE_SNAPSHOT` events, plus a pluggable thread store mapping AG-UI threads to watsonx threads.
- Fixed loss of tool arguments when a tool response arrives before its call record; responses for unknown calls now wait for the call record.
- RAW-only events no longer flush queued tool responses early; pending responses flush only at text or run end.
- Streams that end without `run.completed` or `done` now finish with `RUN_ERROR` instead of `RUN_FINISHED`.
- The 1MB limit now applies per line instead of per read, so large multi-response reads no longer abort the run; reader is cancelled on error.
- Documented `WatsonxRunsAgent`.

### Breaking changes

- Interrupted streams that previously ended as `RUN_FINISHED` now emit `RUN_ERROR`; verify handling of partial runs.
- Tool response/argument queueing and flush timing changed, which may alter the ordering and content of emitted `TOOL_CALL_ARGS` and `onToolResult` events.

## 0.0.3 — 2026-10-14

- Requires AG-UI 1.0 (`@ag-ui/core` / `@ag-ui/client` `>=1.0.0`). `RUN_STARTED` declares `protocolVersion`.
- Streamed tool calls stay on the assistant message in `MESSAGES_SNAPSHOT`, so frontend tools run.
- New `baseUrl` option for private endpoints or OpenAI-compatible mocks. When set, it is used instead of the URL built from `region` and `instanceId`.
- Only text parts are sent in the prompt. Media parts are dropped with a warning instead of being JSON-encoded.

### Breaking changes

None.

## 0.0.2

- Publish the declared MIT license and license file in the npm package.
