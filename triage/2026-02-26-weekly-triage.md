# AG-UI Weekly Issue Triage — Feb 19–26, 2026

## ag-ui-protocol/ag-ui

| # | Title | Category | Priority | Linear Ticket? | Summary |
|---|-------|----------|----------|----------------|---------|
| **#1169** | SDK mismatch: `ReasoningMessageStartEvent.role` — Python `"assistant"` vs TS `"reasoning"` | **Critical Bug** | **P0 - Critical** | Yes | Python SDK defines `role` as `Literal["assistant"]` while TS SDK uses `"reasoning"`. Cross-SDK wire incompatibility — Python backends are rejected by TS clients. |
| **#1185** | `Tool.parameters` optional in TS, but required in Python | **Non-critical Bug** | **P1 - High** | Yes | TS `ToolSchema` allows `parameters` to be omitted, but Python's `Tool` model requires it, causing `ValidationError` when TS tools are sent to Python backends. Already has PR #1188. |
| **#1037** | ag-ui-strands: single `parent_message_id` causes CopilotKit to render only the first tool call | **Non-critical Bug** | **P1 - High** | Yes | Strands adapter reuses one `message_id` for all tool calls in a run, causing CopilotKit to group them into one message and only render the first. Multi-tool-call agents are broken. |
| **#1176** | `AbstractAgent` with `CopilotRuntime` agents type mismatch | **Non-critical Bug** | **P2 - Medium** | Yes | Multiple versions of `@ag-ui/client` and `@ag-ui/core` coexist in the dependency tree (0.0.42, 0.0.43, 0.0.45), causing TypeScript type mismatches. Related to #982 (peerDependencies). |
| **#1163** | `setMessages` has no effect on `CopilotSidebar` when using AG-UI external agents | **Non-critical Bug** | **P2 - Medium** | Yes | Session persistence breaks because `CopilotSidebar` reads from the AG-UI SSE stream context, not the store that `setMessages` writes to. Reporter posted a workaround. |
| **#1162** | `UnsupportedFieldAttributeWarning` from Pydantic with `RunAgentInput` as FastAPI parameter | **Non-critical Bug** | **P3 - Low** | Yes | Pydantic emits warnings (not errors) due to `alias_generator=to_camel` on `ConfiguredBaseModel` when FastAPI generates OpenAPI schemas. Cosmetic but noisy. |
| **#982** | Zod dependency should be `peerDependencies` per official best practices | **Non-critical Bug** | **P2 - Medium** | Yes | Zod is in `dependencies` instead of `peerDependencies` across core, client, and vercel-ai-sdk packages. Causes duplicate Zod instances and version conflicts. |
| **#1136** | `ToolCallArgsEvent` should have a `parentMessageId` field | **Feature Request** | **P2 - Medium** | No | Consistency improvement — "started" and "chunk" events have this field, but "args" does not, requiring double-search through messages. |
| **#650** | No licensing in PyPi distributed packages | **Non-critical Bug** | **P2 - Medium** | Yes | PyPi packages lack LICENSE metadata, blocking downstream compliance automation. Quick fix. |
| **#248** | langgraph agent `TOOL_CALL_START` ignored | **Non-critical Bug** | **P2 - Medium** | Yes | When GPT-4o returns both text and tool calls in the same chunk, the langgraph adapter ignores `TOOL_CALL_START`. Old issue, still open. |

## CopilotKit/CopilotKit

| # | Title | Category | Priority | Summary |
|---|-------|----------|----------|---------|
| **#3279** | `CopilotKitMiddleware` error: `Context` is not JSON serializable | **Non-critical Bug** | **P1 - High** | AG-UI `Context` type is not JSON serializable, breaks LangGraph integration via CopilotKitMiddleware. |
| **#3263** | "Unexpected end of JSON input" when HITL action called without parameters (Google ADK) | **Non-critical Bug** | **P1 - High** | Human-in-the-loop tools with empty parameters set `arguments` to `""`, which fails JSON.parse. |
| **#3242** | Frontend tools via `useFrontendTool` not invokable through A2AAgent + A2AClient path | **Non-critical Bug** | **P1 - High** | Tool invocation works via `HttpAgent` but broken via A2A path. Suggests A2A tool handshake issue. |
| **#3225** | Built bundle size explosion with CopilotKit v1.5+ (600KB to 4.3MB) | **Non-critical Bug** | **P1 - High** | Barrel `*` exports prevent tree-shaking. Major regression for non-Next.js builds. |
| **#3258** | Duplicate React keys in `CopilotChatMessageView` during streaming | **Non-critical Bug** | **P2 - Medium** | Messages with same `id` during streaming cause React key warnings and UI jank. |
| **#3231** | Official LangGraph JS template is outdated and can't upgrade | **Non-critical Bug** | **P2 - Medium** | Template dependencies are stale, fresh install fails. |
| **#3249** | CopilotListeners throws via useAgent when no agents registered | **Non-critical Bug** | **P2 - Medium** | Empty agent state not handled gracefully — throws instead of no-op. |
| **#3244** | `uv.exe ENOENT` error after fresh install | **Non-critical Bug** | **P2 - Medium** | Windows install issue — `uv` binary not found. |
| **#3266** | How to recover historical messages with `useCopilotChatHeadless` | **Question/Support** | **P3 - Low** | User asking for guidance on session restore with headless mode. |
| **#3276** | CopilotSidebar v2 doesn't support `children` prop | **Feature Request** | **P2 - Medium** | V1 had `children` for shrink/expand behavior; v2 overlays instead. |
| **#3274** | Support for Symbolica's Agentica Python SDK integration | **Feature Request** | **P3 - Low** | Community request for new integration. |
| **#3273** | How to set initial state with v2 `useAgent()` | **Question/Support** | **P3 - Low** | Documentation gap — user asking for v2 state initialization guidance. |
| **#3268** | Dependency upgrade request: crewai to 0.177.0+ | **Feature Request** | **P3 - Low** | Request to update crewai dependency. |
| **#3256** | V2 restore state and thread ID | **Question/Support** | **P3 - Low** | User asking about state persistence with v2 API. |

## Recommended for Linear Tickets (Community Asks AOR)

### Critical / P0 — Fix this cycle
1. **ag-ui #1169** — `ReasoningMessageStartEvent.role` Python/TS mismatch (wire-incompatible SDKs)

### High Priority / P1 — Schedule this cycle
2. **ag-ui #1185** — `Tool.parameters` optional in TS but required in Python (PR #1188 already open)
3. **ag-ui #1037** — Strands adapter single `parent_message_id` breaks multi-tool rendering
4. **CopilotKit #3279** — AG-UI `Context` not JSON serializable
5. **CopilotKit #3263** — HITL JSON parse failure for tools without parameters
6. **CopilotKit #3242** — A2A path doesn't route frontend tools
7. **CopilotKit #3225** — Bundle size regression (600KB to 4.3MB)

### Medium Priority / P2 — Backlog
8. **ag-ui #1176** — Type mismatch from multiple `@ag-ui/core` versions
9. **ag-ui #1163** — `setMessages` doesn't affect AG-UI sidebar
10. **ag-ui #982** — Zod should be peerDependencies
11. **ag-ui #650** — PyPi packages lack LICENSE
12. **ag-ui #248** — langgraph TOOL_CALL_START ignored

## Won't-Fix Candidates

No issues this week are clear candidates for "won't fix." All filed bugs represent real protocol or integration issues. The question/support issues (#3266, #3273, #3256) should get a helpful response pointing to docs rather than being closed as won't-fix.

## Draft Responses for Question/Support Issues

### CopilotKit #3273 (How to set initial state with v2 `useAgent()`)
> Thanks for raising this! For v2, initial state can be set through the `state` property in your agent configuration. We'll be updating the docs to cover this pattern more explicitly. In the meantime, you can pass initial state via `useAgent({ state: yourInitialState })` and it will be available in your agent's `STATE_SNAPSHOT` event. Let us know if you hit any blockers.

### CopilotKit #3266 (How to recover historical messages)
> Hi! Session persistence with `useCopilotChatHeadless` is a known gap we're working on. Issue #1163 on the ag-ui repo tracks the same underlying problem. The current workaround is to override the `Messages` component slot on `CopilotSidebar`/`CopilotChat` and merge your restored messages with the live stream. We'll post updates as this gets addressed.

### CopilotKit #3256 (V2 restore state and thread ID)
> Thanks for reporting! State restoration in v2 is being actively discussed. For now, you can initialize state via `useAgent` and persist `threadId` in your application's session store. We'll share docs updates as the pattern solidifies.
