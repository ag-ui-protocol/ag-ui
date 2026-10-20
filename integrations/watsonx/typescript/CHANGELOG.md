# Changelog

## 0.0.3 — 2026-10-14

- Requires AG-UI 1.0 (`@ag-ui/core` / `@ag-ui/client` `>=1.0.0`). `RUN_STARTED` declares `protocolVersion`.
- Streamed tool calls stay on the assistant message in `MESSAGES_SNAPSHOT`, so frontend tools run.
- New `baseUrl` option for private endpoints or OpenAI-compatible mocks. When set, it is used instead of the URL built from `region` and `instanceId`.
- Only text parts are sent in the prompt. Media parts are dropped with a warning instead of being JSON-encoded.

### Breaking changes

None.

## 0.0.2

- Publish the declared MIT license and license file in the npm package.
