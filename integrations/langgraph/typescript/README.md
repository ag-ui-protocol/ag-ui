# @ag-ui/langgraph

Implementation of the AG-UI protocol for LangGraph.

Connects LangGraph graphs to frontend applications via the AG-UI protocol. Supports both local TypeScript graphs and remote LangGraph Cloud deployments with full state management and interrupt handling.

## Media inputs

Audio and document attachments keep their LangChain content type: audio becomes
`audio`, and documents become `file`. Inline bytes, base64 data URLs, and remote
URLs retain their payload and supplied filename; the adapter does not fetch URLs.
Images and videos retain their existing `image_url` representation. For inline
video, the data URL preserves the video MIME type and bytes so existing Gemini
translation continues to work. A supplied image or video filename is recorded on
the user message as `additional_kwargs["ag-ui"].attachments` (block index, block
type and filename), because the `image_url` block has no field providers accept
for it, and is restored onto the same part when the thread is read back. A remote
video URL still reads back as an image, since nothing in it names the modality.

Conversion does not imply model support. The graph's provider, model, and API
must support the supplied media type and source. Provider rejections are reported
as a `RUN_ERROR`. Existing inline WAV/MP3 MIME aliases are normalized for
compatibility, while other audio MIME types remain unchanged. Provider file
handles remain unsupported and are skipped with a warning.

## Run errors

Graph/provider and stream failures are delivered as a terminal `RUN_ERROR`
event, followed by stream completion without `RUN_FINISHED`. This also applies
to text-only runs.

When using `runAgent()`, handle these failures in `onRunErrorEvent`. When
subscribing to `run()`, inspect the emitted `RUN_ERROR` event. These producer
failures no longer reject the `runAgent()` promise or invoke the Observable's
`error` callback. Consumer and client-side validation failures retain their
existing error behavior.

## Installation

```bash
npm install @ag-ui/langgraph
pnpm add @ag-ui/langgraph
yarn add @ag-ui/langgraph
```

## Usage

```ts
import { LangGraphAgent } from "@ag-ui/langgraph";

// Create an AG-UI compatible agent
const agent = new LangGraphAgent({
  graphId: "my-graph",
  deploymentUrl: "https://your-langgraph-deployment.com",
  langsmithApiKey: "your-api-key",
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "Start the workflow" }],
});
```

## Features

- **Cloud & local support** – Works with LangGraph Cloud and local graph instances
- **State management** – Bidirectional state synchronization with graph nodes
- **Interrupt handling** – Human-in-the-loop workflow support
- **Step tracking** – Real-time node execution progress

## Resuming via AG-UI standard `resume[]`

The client sends `RunAgentInput.resume = [ResumeEntry, ...]`. Before starting
or updating the graph, the adapter checks each `interruptId` against the open
interrupts in the checkpoint. Unknown, stale, and duplicate IDs produce a run
error without applying an answer, including after reconnecting with a fresh agent.

The adapter builds LangGraph's native `Command(resume={interruptId: answer, ...})`
map for both single and parallel interrupts. Each resolved interrupt receives its
own `entry.payload` verbatim, including falsy values. A cancelled interrupt receives
`{"__agui_cancelled__": true, "interrupt_id": "..."}`; the graph should branch on
this integration-specific sentinel. Multiple answers are not wrapped in
`__agui_resume_map__`. See [LangGraph's parallel-interrupt documentation](https://docs.langchain.com/oss/python/langgraph/interrupts#handling-multiple-interrupts).

## Migrating to AG-UI 1.0 interrupts

Interrupted runs always end with `RUN_FINISHED.outcome.type = "interrupt"`.
Read `outcome.interrupts` and echo each interrupt's `id` as `interruptId` in
`RunAgentInput.resume[]`. The original LangGraph value remains in
`interrupt.metadata.langgraph.raw`; subagent attribution stays on the interrupt.
No opt-in is required.

```ts
await agent.runAgent({
  runId: "r2",
  resume: [
    { interruptId: "int-abc", status: "resolved", payload: { approved: true } },
  ],
});
```

This is a breaking client migration:

- `CUSTOM(name="on_interrupt")` is no longer emitted.
- `forwardedProps.command.resume` is no longer consumed as a resume directive.
  It cannot clear pending interrupts or bypass resume validation.
- `enableLegacyOnInterruptEvent` / `enable_legacy_on_interrupt_event` and
  `emitInterruptOutcome` / `emit_interrupt_outcome` have been removed.
- TypeScript's `isLegacyCommandResume` and `reconcileLegacyResumeInterrupts`
  exports have been removed, including the `LangGraphHttpAgent` lifecycle bridge.
- Retired `binary` input parts are no longer converted. Send `image`, `audio`,
  `video`, or `document` with a typed `source` (`url`, `data`, or provider `file`).

Upgrade client code before adopting this adapter. Clients whose interrupt hooks
only listen for `on_interrupt` must move to structured outcomes and `resume[]`.
Python requires `ag-ui-protocol>=1.0` and `langgraph>=1.0.10,<2`. The framework
floor makes the 1.0.10 opt-in checkpoint hardening available and supports the existing
`langchain>=1.2.0` dependency. TypeScript requires
`@ag-ui/core` and `@ag-ui/client` 1.0 or later.

LangGraph's native `interrupt()` and `Command(resume=...)` remain unchanged.
The adapter translates canonical resume entries into that native command,
including cancellation and ID-addressed parallel answers described above. Existing
checkpoint replay and persisted-session handling remain supported.

### Capabilities

`LangGraphAgent.getCapabilities()` returns `humanInTheLoop: { supported: true, interrupts: true, approveWithEdits: true }`.

### Customising the HITL bridge (subclass hooks)

If your graph uses a middleware whose interrupt value carries structured payloads (e.g. LangChain's `HumanInTheLoopMiddleware` with `action_requests` / `review_configs`), you can override two protected methods instead of monkey-patching the run loop:

```ts
import { LangGraphAgent, langGraphInterruptToAGUI } from "@ag-ui/langgraph";
import type { Interrupt as AGUIInterrupt, ResumeEntry } from "@ag-ui/core";
import type { Interrupt as LangGraphInterrupt } from "@langchain/langgraph-sdk";

class HITLLangGraphAgent extends LangGraphAgent {
  protected interruptsToAGUI(
    list: readonly LangGraphInterrupt[],
  ): AGUIInterrupt[] {
    const out: AGUIInterrupt[] = [];
    for (const lg of list) {
      const value = lg.value;
      if (
        typeof value === "object" &&
        value !== null &&
        "action_requests" in value
      ) {
        out.push(...myActionRequestsToAGUI(value));
      } else {
        out.push(langGraphInterruptToAGUI(lg));
      }
    }
    return out;
  }

  protected buildCommandResumeFromAgui(
    entries: readonly ResumeEntry[],
    ctx: { openInterrupts: AGUIInterrupt[] },
  ): unknown {
    return myResumeToDecisions(entries, ctx.openInterrupts);
  }
}
```

The base class handles snapshot ordering, canonical interrupt outcomes, and resume preparation; subclasses only translate their native interrupt values and decisions.

## To run the example server in the dojo

```bash
cd integrations/langgraph/typescript/examples
langgraph dev
```

### Standalone canonical client

[examples/canonical-resume.ts](examples/canonical-resume.ts) demonstrates the
public `HttpAgent` lifecycle against a LangGraph-backed AG-UI endpoint using
`pendingInterrupts` and `resume[]`. Run it with an AG-UI 1.0 client and a
TypeScript runner, setting `AG_UI_URL` to your endpoint.

The shared Dojo uses CopilotKit 1.76's `useInterrupt` hook for human-in-the-loop,
subgraph, and deepagents approval pickers. It reads `metadata.langgraph.raw` from the structured
interrupt and resolves the selected interrupt ID through `resume[]`. Browser
coverage exercises Python Platform, TypeScript Platform, and FastAPI, with
protocol-version checks enabled for all three lanes.

The TypeScript examples remain an isolated workspace with their published
`@ag-ui/langgraph` pin. Bump that pin after the adapter release tracked by
PNI-548; downstream CopilotKit adoption is tracked by PNI-551.

The TypeScript adapter retains its message-tuple stream fallback: a local
SDK version does not establish the remote LangGraph server's streaming
capabilities, and callers can still select the stream mode explicitly.
Provider conversions and persisted-history handling also remain supported.
