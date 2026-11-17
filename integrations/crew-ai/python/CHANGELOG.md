# Changelog

## 1.0.0 — 2026-10-09

- Declares `protocol_version=PROTOCOL_VERSION` on every `RunStartedEvent`, including both StreamFrameTranslator sites and the legacy bus listener.
- Adapter now sources validators from `@ag-ui/core/schemas`, follows part renames, flattens tool result content to text where needed, and drops file sources with a warning instead of sending provider handles.
- Resumed native sessions now require native frames and use unified streaming; teardown is bounded and cleanup is cancelled at its deadline.
- Removed the leftover `uvicorn<0.35.0` cap, allowing installation alongside packages needing uvicorn 0.35+ such as fastmcp 2.14 (floor remains 0.34.3).

### Breaking changes

- Requires `ag-ui-protocol>=1.0.0`; the protocol floor was raised to 1.0.
- `RUN_STARTED` events now include a `protocolVersion` field; consumers parsing these events should re-verify handling.
- Adapter validation moved to the 1.0 models with renamed parts; tool result content is flattened to text and unsupported file sources are dropped, changing emitted output.
- Resumed native sessions now require native frames.

## 0.3.1 — 2026-09-14

- `RunAgentInput.context` is now retained on `CopilotKitState`; previously Pydantic discarded it before `@start` ran.
- Endpoint helpers now forward FastAPI route kwargs (name, tags, summary, operation_id, dependencies, include_in_schema).
- Conversational runs whose stream carries no translatable frames now terminate with a proper terminal event instead of an empty HTTP 200.
- Abandoned conversational Flow workers are now bounded and contained after client disconnect, timeout, or cancellation.
- OpenAI Responses handling simplified to use the public `aresponses` entrypoint; fixes `output_item.done`.
- `pydantic` (v2, `<3`) is now a declared direct dependency.
- Ctrl-C now stops the dojo server instead of requiring SIGKILL.
- Dojo app is now built once per boot in the serving process.
- Removed the dead, fully commented-out `enterprise.py` module from published artifacts.
- Published distributions now include a Changelog URL in metadata.
- The `dev` console script is no longer published; run the dojo via the relocated examples project instead.
- The dojo server and demo flows moved into a separate examples project and are no longer shipped in the published package.
- `enterprise.py` removed from the package.
