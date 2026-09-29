# Changelog

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
