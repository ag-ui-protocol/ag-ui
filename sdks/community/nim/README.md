# AG-UI Nim SDK

A community Nim SDK for the [AG-UI protocol](https://docs.ag-ui.com), version
**1.0**. The types and the JSON codec follow
[`spec/1.0/schema.json`](../../../spec/1.0/schema.json) definition by
definition, and the test suite runs the spec's own fixtures against them.

Requires Nim 2.2 or later. No dependencies beyond the Nim standard library.

## Installation

The package lives in a subdirectory of the AG-UI monorepo and is not in the
Nimble package index. Nimble installs a package from a repository
subdirectory with the `?subdir=` URL query:

```bash
nimble install "https://github.com/ag-ui-protocol/ag-ui?subdir=sdks/community/nim"
```

or, as a dependency in your `.nimble` file:

```nim
requires "https://github.com/ag-ui-protocol/ag-ui?subdir=sdks/community/nim"
```

From a checkout, `nimble install` inside `sdks/community/nim` does the same.
The package is named `ag_ui_nim`.

## Usage

```nim
import std/[asyncdispatch, json]
import ag_ui_nim

# Decode an event. `fromJson` without a context checks the 1.0 schema exactly.
let event = parseJson(
  """{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Hi"}""").fromJson(Event)
doAssert event.kind == etTextMessageContent
doAssert event.textMessageContent.delta == "Hi"

# Build events and frame them for an SSE response.
let frame = encodeSse(TextMessageStartEvent(messageId: "m1").toEvent)
doAssert frame == "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"m1\"}\n\n"

# Run an agent over HTTP and fold its events into the conversation.
let input = RunAgentInput(threadId: "t1", runId: "r1", messages: @[
  UserMessage(id: "u1", content: textContent("Hello")).toMessage])
var conversation = AgentState(messages: input.messages, state: newJObject())
waitFor newHttpAgent("http://localhost:8000/agent").runAgent(input,
  proc (e: Event) = conversation.applyEvent(e),
  proc (warning: string) = stderr.writeLine(warning))
```

### Strict and receiver decoding

The schema closes every object, and a whole `null` in place of an optional
field is invalid. A receiver is asked to be more forgiving (see
`spec/README.md` and `DEPRECATIONS.md`): it strips fields it does not
recognise and reads the listed pre-1.0 whole-field `null`s as absent, warning
about each. The decoder does either:

```nim
var ctx = receiverContext()   # or strictContext()
let e = fromJson(node, Event, ctx)
for warning in ctx.warnings: echo warning
```

`HttpAgent` decodes with the receiver policy and passes the warnings to its
warning callback. A rejected document raises `ValidationError`, whose
`keyword` and `instanceLocation` name the schema rule and the JSON Pointer of
the offending value.

The encoder leaves an absent optional field out instead of writing `null`,
and keeps a `null` where the protocol carries one (a `STATE_SNAPSHOT`
snapshot, a `CUSTOM` value, a JSON Patch value).

## What is implemented

| Area | Status |
| --- | --- |
| Events | All 31 event types of 1.0, including `REASONING_*`, `ACTIVITY_*`, `TOOL_CALL_RESULT` and `SUBAGENT_STARTED`/`FINISHED`/`ERROR`, with the `BaseEvent` members (`timestamp`, `rawEvent`, `metadata`) and `subagentRunId` on the events the schema makes attributable |
| Messages | All 7 roles (developer, system, assistant, user, tool, activity, reasoning) with `name`, `encryptedValue`, `metadata` and `subagentRunId` where the schema has them |
| Content | A string or content parts: text, image, audio, video and document parts with data, URL and file sources |
| Run input | `RunAgentInput` with `protocolVersion`, `parentRunId`, `state`, `tools`, `context`, `forwardedProps` and `resume` |
| Outcomes | `RUN_FINISHED` `result`, `outcome` (success / interrupt / cancelled) and `usage` (`TokenUsage`); `SUBAGENT_FINISHED` `result` and `outcome` (success / suspended); `Interrupt`, `ResumeEntry` |
| Capabilities | `AgentCapabilities` and every capability group |
| JSON Patch | The six RFC 6902 operations as a type, and applying a patch to a document (`applyPatch`) |
| Codec | Strict and receiver decoding, null-omitting encoding. Every definition in the schema has a Nim counterpart: an object, an enum or an object variant for each union; the six patch operations are the branches of `JsonPatchOperation`; `SubagentRunId` and `JsonPointer` are validated strings; `Metadata` and `State` are `JsonNode`; the mixins (`BaseEvent`, `Attributable`, `BaseMessage`) are folded into the types that use them |
| Transport | SSE framing for producers (`encodeSse`), an incremental SSE parser, and `HttpAgent`, which POSTs the run input and streams the events back |
| State | `AgentState.applyEvent`, which folds events into the message history and the shared state following the TypeScript client's reducer (see below for what is not ported) |
| Removed | The pre-1.0 `THINKING_*` events are not part of 1.0 and are rejected |

## What is not implemented

- **The protobuf transport** (`application/vnd.ag-ui.event+proto`). Only SSE
  with JSON is supported.
- **Expanding chunk events.** `TEXT_MESSAGE_CHUNK`, `TOOL_CALL_CHUNK` and
  `REASONING_MESSAGE_CHUNK` decode and encode, but `applyEvent` raises
  `UnexpandedChunkError` for them, as the TypeScript reducer does; the
  expansion into start/content/end events is not ported.
- **Event-sequence verification** (the TypeScript client's `verifyEvents`):
  ordering and lifecycle rules are not checked.
- **Parts of the reducer**: merging event `metadata` into messages, subscriber
  hooks, and the merge rules of `MESSAGES_SNAPSHOT` (here a snapshot replaces
  the history).
- **Pre-1.0 compatibility shims** other than reading the listed deprecated
  `null`s as absent: `THINKING_*` translation, legacy `binary` content parts
  and the version-gated middlewares are not ported.
- **The conformance corpus** in `spec/1.0/conformance/` is a regression suite
  for the first-party TypeScript and .NET clients; its lanes are not run here.

## Tests

```bash
nimble test
```

runs every `tests/test_*.nim` and fails on a test failure or a compiler
warning. The suite reads fixtures from the monorepo, so run it from a
checkout:

- `spec/1.0/fixtures/` — every valid document round-trips through its
  definition; every invalid one is rejected for the rule its `.expect.json`
  names.
- `sdks/fixtures/null-omission.json` and `sdks/fixtures/agent-capabilities.json`
  — the cross-language wire-format fixtures, walked case by case.
- RFC 6902 Appendix A for JSON Patch, the SSE parsing rules, the reducer, and
  `HttpAgent` against a local server.

CI runs the suite on every change to this directory, the schema or the shared
fixtures (`.github/workflows/unit-nim-sdk.yml`).

## Layout

```
src/ag_ui_nim.nim        re-exports the three layers below
src/ag_ui_nim/core/      validation, codec, types, capabilities, events, patch, stream
src/ag_ui_nim/encoder/   SSE framing
src/ag_ui_nim/client/    SSE parser, HttpAgent
tests/                   std/unittest suites
```

## License

MIT
