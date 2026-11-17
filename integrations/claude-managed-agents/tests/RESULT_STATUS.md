# Managed tool-result failure fidelity (PNI-691)

Native `agent.tool_result`, `agent.mcp_tool_result` and recovered
`user.custom_tool_result` events preserve their original result and call IDs.
AG-UI has no top-level error field on `TOOL_CALL_RESULT`, so failures use the
existing SDK-adapter convention of structured content:

- Plain text: the content string encodes `{"error":true,"content":"original text"}`.
  The original text, including whitespace and JSON-looking strings, is unchanged
  inside `content`. Empty failed results encode an empty string.
- Rich results: each standard content part retains its existing
  `metadata.claudeManagedAgents` native block and gains `metadata.isError: true`.
- Success or absent native failure flags retain the previous representation.
- RAW native events remain unchanged. Backend custom-tool exceptions use the
  same failure envelope; their existing synthetic result IDs are unchanged.

The live turn and parent/child recovery paths all use this conversion. Consumers
recording AG-UI content retain the status on replay without a protocol change.
Intelligence's separate native importer already represents failure on its tool
message; this patch does not change that importer.

## Reproduction and coverage

Run commands from the repository root, with one build/test worker:

```sh
AGUI_TEST_PYTHON=python3 NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run @ag-ui/claude-managed-agents:test --parallel=1 --maxWorkers=1
cd integrations/claude-managed-agents/python
uv sync --group dev
uv run pytest -q
cd ../dotnet
AGUI_TEST_PYTHON=python3 dotnet test tests/AGUI.ClaudeManagedAgents.Tests/AGUI.ClaudeManagedAgents.Tests.csproj -m:1 -p:BuildInParallel=false
```

`AGUI_TEST_PYTHON` must identify a working Python 3 executable for the TS and .NET
localhost-provider tests. Python tests use their own interpreter. No provider
credentials or paid calls are required. `tests/result_provider.py` binds only to
127.0.0.1 and replays the existing, unmodified `fixtures/child-results.json`.
Each native SDK makes real HTTP/SSE requests to a separate local provider process.

Coverage in all three languages:

- Connected parent native success/denial content and canonical identities.
- Saved real child allow and deny results through cold imported-session approval.
- Child result exactly once, including duplicate/cross-post controls.
- Native SDK localhost transport, provider process restart, new adapter instance,
  serialized/restored session store, and no duplicate result after reload.
- Rich native/MCP/custom result recovery with original RAW event and failure metadata.
- Backend custom-tool exceptions preserve failure status after delivery succeeds.

The new plain-result regression fails against the baseline in each language:
only denial cases fail because their content is still an unstructured string;
matching success cases pass. Fixed suites pass. These tests assert result data,
not assistant success prose.

## Integration boundaries

This is an adapter candidate, not full PNI-646 acceptance or a published release.
The coordinator must install the exact PR head in the combined Intelligence and
CopilotKit harness, then compare fresh recordings and native-only imports,
answers after browser/API restart, and repeated imports. Shared-state changes
from PNI-692 are separate; this patch does not edit `agent.ts` or `agent.py`.

Native `user.custom_tool_result` events are still RAW-only during live streaming;
locally executed custom tools still emit synthetic result IDs, while native
custom-result recovery retains native IDs. Those existing behaviors are not
claimed as new canonical live custom-result identity coverage.

The tests do not certify all rich-thread items, production browser persistence,
new paid-provider behavior, or released package compatibility. Existing native
fixtures, campaign evidence and provider budget ledgers are not changed.
