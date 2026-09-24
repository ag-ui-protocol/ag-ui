# LangGraph transformer parity

Base: PR #1651 at `b81f1d8f47a9e2bb85a5af48ef230cc3f168b38b`, including the already-merged raw V3 work in #2810. Branch: `fix/langgraph-v3-transformer-parity`.

## Current result

| Difference                                                            | Classification            | Result                                                                              |
| --------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| Missing middleware steps and a model step closed/reopened at takeover | Adapter omission          | Transformer takes ownership from the first root task                                |
| Missing messages in state; premature or duplicated message snapshots  | Adapter mismatch          | State retains messages; canonical message snapshot waits for terminal reduced state |
| LangChain class internals in TypeScript state                         | Serialization bug         | Serialize live public message fields, including restored tool calls                 |
| Python snake_case event envelopes                                     | Wire bug                  | Serialize AG-UI aliases while preserving null application payloads                  |
| Backend tool results/errors and subsequent state updates              | Adapter omission          | Emit results and resume snapshots after backend tool completion/error               |
| Usage only present on V2 final model output                           | Adapter omission          | Capture final output usage without recounting the same streamed invocation          |
| Available usage missing from old greeting reference                   | Intentional addition      | Explicit V2 golden updater; only semantic difference is RUN_FINISHED.usage          |
| Python Platform injects internal configuration as app context         | Upstream runtime behavior | Still prevents exact Python browser parity; not filtered from message history       |

The real TypeScript transformer greeting and unchanged raw V3 greeting both pass Chromium against the established V2 reference. Python renders the reply after the wire fix, but exact trace parity remains incomplete. No claim of full tool/interrupt/multiturn browser parity or merge readiness is made.

## Reference and verification

The dedicated `transformerParity` greeting starts from the exact V2 `sendsAndReceivesMessage` reference at `40284a07ad184eddc7fc77bda8fa23ff64398af9:apps/dojo/e2e/tests/langgraphTypescriptTests/agenticChatPage.event-trace.ts`. It uses the existing comparator without modifications.

The reference was updated through:

```sh
BASE_URL=http://localhost:19999 AIMOCK_PORT=15555 \
  pnpm --dir apps/dojo/e2e event-trace:update --spec transformerParity \
  --reason 'Preserve the established V2 greeting and add provider-reported RUN_FINISHED usage captured from final model output; verified on pinned V2 dependencies.'
```

Dojo was forced to V2 and pointed at a separate control graph with the historical dependency baseline: LangGraph 1.3.0, core 1.1.46, checkpoint 1.0.2, SDK 1.9.2, OpenAI 1.2.0, LangChain 1.2.8, CopilotKit SDK 1.57.1. A direct V2 capture first reproduced the historical reference and revealed usage on `on_chat_model_end` that the adapter had missed.

The updater writes normalized traces, so the stored reference changes from 31 to 18 events. Independently normalizing both the original reference and the updater output proves that the only semantic change is:

```json
{
  "usage": [
    {
      "provider": "openai",
      "model": "gpt-4o",
      "inputTokens": 11,
      "outputTokens": 10,
      "totalTokens": 21
    }
  ]
}
```

The comparator already collapses repeated state snapshot pulses and removes RAW provenance. This change does not modify that behavior or claim literal equality of every pre-normalization V2 callback pulse.

## Explicit execution lanes

The ordinary example graph exports remain unchanged. Separate `langgraph.transformer.json` files in the TypeScript and Python examples register the actual transformer on the existing greeting graph.

Configure Dojo before starting Next:

| Lane           | Dojo environment                                                                      | Graph configuration                      |
| -------------- | ------------------------------------------------------------------------------------- | ---------------------------------------- |
| V2 control     | `LANGGRAPH_STREAM_PROTOCOL_FOR_TESTS=v2`                                              | Ordinary graph on pinned V2 dependencies |
| Raw V3         | `LANGGRAPH_STREAM_PROTOCOL_FOR_TESTS=v3 LANGGRAPH_EVENT_SOURCE_FOR_TESTS=raw`         | Ordinary graph                           |
| Transformer V3 | `LANGGRAPH_STREAM_PROTOCOL_FOR_TESTS=v3 LANGGRAPH_EVENT_SOURCE_FOR_TESTS=transformer` | `langgraph.transformer.json`             |

Set `LANGGRAPH_TYPESCRIPT_URL` and `LANGGRAPH_PYTHON_URL` to the corresponding Platform servers. Forced V3 fails on subscription errors rather than accepting a fallback. The source assertion verifies observed passthrough events, not merely the graph configuration or method name. Specifying a source also requires V3; combining it with forced V2 fails.

With Node 22, a running Dojo, and model servers configured for the local mock endpoint:

```sh
BASE_URL=http://localhost:19999 AIMOCK_PORT=15555 \
  pnpm --dir apps/dojo/e2e exec playwright test \
  tests/langgraphTypescriptTests/transformerParity.spec.ts --workers=1 --retries=0
```

Use the existing Python `agenticChatPage.spec.ts` greeting to reproduce its remaining mismatch. Do not refresh the Python golden to accept internal runtime metadata.

## Python Platform mismatch

The locked Platform API 0.7.96 does not expose V3 stream endpoints and falls back to V2. Real transformer execution was therefore tested in an isolated environment with API 0.9.1, then 0.14.4, LangGraph 1.2.10, LangChain 1.3.14, OpenAI 1.0.2, and CopilotKit 0.1.86. Repository locks were not changed.

Both V3-capable Platform versions inject `__event_streaming_v2` and `thread_id` into `configurable` in `event_streaming/service.py` and set the run context to `None`. `models/run.py` then copies configurable into runtime context. CopilotKit's `before_agent` middleware treats that runtime context as application context and inserts a SystemMessage containing those internal fields. This occurs before transformer serialization, in actual graph state and model input. The transformer must not conceal it by deleting a real message.

After the adapter fixes, the direct Python greeting contains 18 normalized events versus V2's 17: the extra state transition and final message payload carry this injected SystemMessage. Python's V2 contract also differs from TypeScript: it does not emit a provisional assistant-only task-result snapshot. The Python transformer preserves its own V2 ordering.

Python's provider in this test environment does not report token usage, so its terminal omits usage rather than inventing a value.

## Final local checks

- TypeScript package: 947 tests passed, two existing todo tests; explicit typecheck and build passed through Nx.
- Python package: 863 pytest tests passed (735 subtests), including 72 transformer tests.
- Dojo event-trace TypeScript check and all 138 event-trace unit tests passed.
- Chromium greeting: forced V2 reference capture, forced actual transformer V3, and forced raw V3 passed with no retries.
- Python Chromium greeting renders the reply but fails the unchanged event contract; the remaining upstream context discrepancy is described above.

## Evidence and remaining scope

Task evidence is preserved in `/private/tmp/transformer-lane/`: `golden-update2.log`, `verify-golden.mts`, `verified-browser.json`, `python-fixed-browser.json`, `python-current-capture.log`, and `python-v3.json`. The TypeScript browser report has one expected test, no failures or retries, and Dojo logs `event-trace source: transformer`.

Focused regression coverage includes root task ownership, concurrent same-name tasks, snapshot payloads, live message/tool linkage serialization, tool success/error, Python wire aliases and null values, source enforcement, and V2 final-output usage. The existing package suites cover additional terminal, usage, interrupt, and tool paths. A bounded independent review identified Python's missing tool-completion reset; it was reproduced and fixed with regression coverage.

The Python upstream context defect and broader real-browser tool/interrupt/multiturn comparisons remain unresolved. This work is published as a draft while those gaps remain. No comparator was weakened or FastAPI code changed.
