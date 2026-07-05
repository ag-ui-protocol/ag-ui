# AG-UI × OpenAI Agents SDK

Integrates [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
with [AG-UI Protocol](https://github.com/ag-ui-protocol/ag-ui). Build your
agent with the OpenAI SDK as usual, then stream its execution as AG-UI events.

## Install

```bash
pip install ag-ui-openai-agent-sdk
uv sync
```

## Testing

```bash
uv sync            # installs dev group (pytest)
uv run pytest      # run the full suite
```

The suite includes a **drift guard** (`tests/test_stream_types_drift.py`):
this package hardcodes the wire `type` strings it dispatches on (in
`translator/stream_types.py`), and the guard asserts each one against the
`Literal[...]` annotations of the installed `openai-agents` / `openai`
packages. After bumping either dependency, run `uv run pytest` — if a wire
type was renamed or a new hosted tool-call item type was added, the guard
fails with an assertion diff naming the exact value to update in
`stream_types.py`. Unknown types never crash at runtime (the translator
degrades gracefully and skips them); the guard exists so drift is caught in
CI instead of silently dropping events.