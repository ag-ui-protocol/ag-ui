# mastra-agui

Project-specific adapter layer built on top of the official `@ag-ui/mastra` approach.

The goal is not to invent a new protocol. The goal is to stay compatible with `AbstractAgent`, `RunAgentInput`, and the AG-UI event model while adding the reliability and extension points this codebase needs.

## Why not use the official adapter directly

The official adapter is a good fit for straightforward `Mastra stream chunk -> AG-UI event` bridging.

This project additionally needs:

- child-agent delegation modes
- nested `tool-output` / workflow event unpacking
- reasoning event bridging
- project-level safeguards around `requestContext`, memory, abort, and error handling

If all of that stays inside `run()` / `stream()` via a growing `switch (chunk.type)`, the core class keeps expanding. Every new chunk behavior or project-specific mode would require touching the main execution path again.

## Why introduce a Registry

**Purpose: separate run lifecycle management from chunk handling strategy.**

The official and legacy implementations lean toward hard-coding chunk-to-event mapping inside the streaming loop. `ChunkHandlerRegistry` moves that mapping layer out so it can be composed, replaced, or extended without repeatedly changing `MastraAgentAdapter`.

It solves three practical problems:

| Goal | Why it matters |
| --- | --- |
| Keep the core class stable | `MastraAgentAdapter` focuses on run, abort, memory, `requestContext`, and local/remote streaming. |
| Make extensions pluggable | `createDefaultRegistry()` provides the defaults, and projects can extend them via `append`, `replace`, or `skip` instead of forking the adapter. |
| Support project-specific flows | `adapter/delegation-registry.ts` builds child-agent delegation, supervisor unpacking, and reasoning bridging on top of the registry. |

In one sentence: **the Registry exists to pull event-conversion rules out of the main run loop, reduce coupling, and make project-specific behavior easier to maintain.**

## Resolved bugs

| # | Area | Problem | Resolution |
| --- | --- | --- | --- |
| 1 | `utils.ts` | Tool name lookup from `tool` messages was effectively O(n²) in the worst case. | `buildToolNameIndex()` now builds a single-pass map for constant-time lookup. |
| 2 | `utils.ts` | `binary` content such as images or files could be dropped during conversion. | `toMastraUserContent()` now maps binary payloads to `ImagePart` / `FilePart`. |
| 3 | `utils.ts` | `system` and `developer` messages were not converted, causing data loss. | Both roles are now handled explicitly during AG-UI to Mastra conversion. |
| 4 | `mastra.ts` | Local `agent.stream()` calls did not receive an `abortSignal`. | The adapter now passes `ctrl.signal` so upstream work can be cancelled. |
| 5 | `registry.ts` | Server-assigned step `messageId` values were not synced back into the runtime context. | `step-start` and `step-finish` now call `ctx.syncMessageId(...)` when possible. |
| 6 | `registry.ts` | `abort` chunks were ignored, which could leave the stream hanging. | The `abort` handler now calls `ctx.markAborted()`. |
| 7 | `mastra.ts` | Local streaming lacked a guaranteed cleanup path around `for await`. | Stream iteration now runs inside `try/finally`. |
| 8 | `mastra.ts` | Remote streaming did not react correctly to mid-stream aborts. | The adapter now wires `abortSignal` into remote processing and marks the context aborted. |
| 9 | `mastra.ts` | Observable teardown did not stop the underlying stream. | Teardown now aborts the controller and removes the thread entry. |
| 10 | `mastra.ts` | Emitting after the subscriber closed could throw. | `emit()` and `fail()` now guard on `!subscriber.closed`. |
| 11 | `registry.ts` | Message IDs were not rotated correctly after `finish`. | The `finish` handler now calls `ctx.rotateMessageId()`. |
| 12 | `mastra.ts` | The implementation depended on an unsafe `agent.name!` assumption. | Factory helpers now use the explicit `agentId` input instead. |
| 13 | `utils.ts` | Original message IDs were not preserved, which could cause duplicate history insertion. | Message conversion now preserves the original AG-UI `message.id` values. |

## What the implementation includes

- `MastraAgentAdapter`
  - run lifecycle
  - local / remote stream dispatch
  - abort handling
  - working memory sync and state snapshot
- `ChunkHandlerRegistry`
  - chunk handler registration and dispatch
  - `replace` / `append` / `skip`
  - `fail-fast` / `continue`
- `createDefaultRegistry()`
  - built-in AG-UI event mapping
- `registerCopilotKit()`
  - route registration and `RequestContext` fallback
- compatibility aliases
  - `MastraAgent` → `MastraAgentAdapter`
  - `MastraAgentConfig` → `MastraAdapterConfig`
  - `MastraAgentOptions` → `MastraAdapterOptions`

## Minimal usage

```ts
import { MastraAgentAdapter } from './mastra-agui';

const adapter = new MastraAgentAdapter({
  agentId: 'writer',
  agent,
  resourceId: 'user-123',
});
```

## When to customize the Registry

Customize the Registry when you need to change how chunks become AG-UI events without modifying `MastraAgentAdapter` itself.

Common cases:

- append project-specific behavior for `tool-call` / `tool-result`
- intercept `tool-output` and unpack nested workflow / supervisor events
- change `finish` / `error` completion behavior
- attach debugging or logging to chunk handling

```ts
const adapter = new MastraAgentAdapter(config, {
  registry: (registry) =>
    registry.register(
      'tool-result',
      (chunk, ctx) => {
        ctx.logger.info('custom.tool-result', {
          runId: ctx.runId,
          toolCallId: chunk.payload.toolCallId,
        });
      },
      'append',
    ),
});
```

In the default case, you should not need to touch the Registry directly. Customize it only when the project needs non-standard chunk semantics.

## File structure

```
mastra-agui/
  mastra.ts     ← adapter class: run lifecycle / abort / memory
  registry.ts   ← chunk handler registry and default mapping
  types.ts      ← public types and StreamRunContext
  utils.ts      ← AG-UI message -> Mastra message conversion
  logger.ts     ← logging adapter
  copilotkit.ts ← route registration
```
