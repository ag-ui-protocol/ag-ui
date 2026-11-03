# Changelog

## 0.0.2 — 2026-10-14

- Requires AG-UI 1.0 (`ag-ui-protocol>=1.0.0`). `RUN_STARTED` declares `protocol_version`.
- Only text parts are sent to watsonx Orchestrate. Other parts are dropped with a warning instead of being JSON-encoded into the prompt.
- Tool results with content parts pass through to `TOOL_CALL_RESULT`.
- The FastAPI endpoint helpers forward route options (`name`, `tags`, `dependencies`, ...), and FastAPI is imported only when they are used.
- The package ships its MIT license file.

### Breaking changes

None.
