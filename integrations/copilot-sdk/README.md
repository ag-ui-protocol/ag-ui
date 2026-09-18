# GitHub Copilot SDK for AG-UI

Native Python and TypeScript integration work for
[github/copilot-sdk#2318](https://github.com/github/copilot-sdk/issues/2318):
**Make Copilot SDK consumable for end-users by adding first-class AG-UI protocol
support**.

Development fork: [ArlindNocaj/ag-ui](https://github.com/ArlindNocaj/ag-ui).
Feature branch: `feature/add-copilot-sdk-support`. This is fork-only review
against `ArlindNocaj/ag-ui:main`, not an upstream pull request or maintainer
approval. No package publication is implied by this work.

## Packages and examples

- [Python](./python): native `github-copilot-sdk==1.0.14`, managed with `uv`.
- [TypeScript](./typescript): native `@github/copilot-sdk@1.0.14`.
- [Shared mapping fixtures](./fixtures): the same synthetic event contract in
  both languages, separate from live SDK evidence.
- Dojo entries: `copilot-sdk-python` and `copilot-sdk-typescript`. Only
  `agentic_chat` is advertised there. The bundled servers require no sibling
  checkout; richer external application samples are not part of this package.

The SDK manages its matching runtime. Authentication is inherited by the backend
process; credentials are not extracted, copied into frontend configuration, or
forwarded to another model provider.

The workspace keeps its normal release-age policy. Its exception is restricted
to the verified SDK `1.0.14` release and that release's eight matching platform
packages; it does not exempt future SDK versions. The SDK's Zod 4 dependency is
scoped separately from AG-UI's Zod 3 dependency.

## Frontend tools are ordinary tool continuations

A browser-owned tool uses a declaration-only SDK tool and this wire sequence:

```text
TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_END
RUN_FINISHED
browser executes the tool
next RunAgentInput includes a role:"tool" message
the adapter resolves the original pending SDK request
the original SDK conversation continues
```

Native `requestId` values remain server-owned. The browser answers using the
original `toolCallId`. The adapter must not turn the result into a user prompt,
re-submit the complete conversation to the model, or echo the browser's own
`TOOL_CALL_RESULT`. Frontend handoff is not an AG-UI interrupt.

The initial registry is in-process. Use one backend process or sticky routing;
restarting the backend loses ownership/pending-request mappings. SDK session
resumption alone is not a durable adapter-state implementation. Stale
continuations must fail explicitly rather than silently start another session.

## Protocol and source capability

The tested protocol baselines are TypeScript `@ag-ui/*@0.0.59` and Python
`ag-ui-protocol==0.1.22`. Child attribution uses the actual SDK `agentId`, not the
chronological event-envelope `parentId`, and the standard AG-UI `SUBAGENT_*`
events and `subagentRunId` fields.

Tool execution output is distinct from argument streaming. The
`copilot-sdk:tool` activity carries actual partial output, progress, status, and
an exit code only when available. A successful tool invocation can still report
a nonzero shell exit code; the command card must show failure without rewriting
the original tool result.

Readable reasoning is model/runtime-dependent. Absence of source reasoning is
not fabricated, and encrypted/opaque reasoning is not broadcast as text.
Deterministic fixtures and credential-free CI do not establish live model
capabilities. Live verification remains a separate, local acceptance lane.
