# AG-UI — Skill Spec

AG-UI is an open, lightweight, event-based protocol that standardizes how AI agent backends communicate with user-facing applications. It provides ~16 standardized event types, transport-agnostic communication (SSE, WebSockets, HTTP binary), and a flexible middleware layer for event transformation.

## Domains

| Domain | Description | Skills |
| ------ | ----------- | ------ |
| Implementing Agents | Building agent classes that emit AG-UI events | implement-abstract-agent, http-agent-setup |
| Event Streaming | Working with the event protocol lifecycle and streaming | text-message-events, run-lifecycle, custom-and-raw-events |
| State and Messages | State synchronization and conversation history management | state-synchronization, serialization |
| Tool Integration | Frontend tool calling and human-in-the-loop workflows | tool-calling-events, human-in-the-loop |
| Middleware and Transport | Event transformation, filtering, and encoding | middleware, event-encoding |
| Advanced Protocol Features | Reasoning, capabilities, activities, generative UI | capability-events, reasoning-events, activity-events, generative-ui |

## Skill Inventory

| Skill | Type | Domain | What it covers | Failure modes |
| ----- | ---- | ------ | -------------- | ------------- |
| implement-abstract-agent | core | Implementing Agents | AbstractAgent, run(), Observable, event emission | 6 |
| http-agent-setup | core | Implementing Agents | HttpAgent, SSE, headers, abort | 3 |
| text-message-events | core | Event Streaming | TEXT_MESSAGE_*, CHUNK, messageId | 4 |
| tool-calling-events | core | Tool Integration | TOOL_CALL_*, Tool definition, JSON Schema | 5 |
| human-in-the-loop | core | Tool Integration | Approvals, tool-based HITL (interrupt/resume is draft, excluded) | 2 |
| capability-events | core | Advanced Features | AgentCapabilities, getCapabilities(), all capability categories | 3 |
| reasoning-events | core | Advanced Features | REASONING_*, encryption, ZDR, deprecated THINKING_* | 3 |
| state-synchronization | core | State and Messages | STATE_SNAPSHOT/DELTA, JSON Patch, MESSAGES_SNAPSHOT | 4 |
| middleware | core | Middleware and Transport | MiddlewareFunction, Middleware class, FilterToolCalls | 4 |
| activity-events | core | Advanced Features | ACTIVITY_SNAPSHOT/DELTA, ActivityMessage, replace flag | 3 |
| run-lifecycle | core | Event Streaming | RUN_STARTED/FINISHED/ERROR, steps, sequential runs | 4 |
| custom-and-raw-events | core | Event Streaming | RAW, CUSTOM events | 3 |
| serialization | core | State and Messages | Stream persistence, compaction, branching, parentRunId | 3 |
| event-encoding | core | Middleware and Transport | EventEncoder, SSE/protobuf, Accept/Content-Type | 3 |
| generative-ui | composition | Advanced Features | A2UI, Open-JSON-UI, MCP-UI, AG-UI as transport | 3 |

## Failure Mode Inventory

### implement-abstract-agent (6 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Emitting events before RUN_STARTED | CRITICAL | verify/verify.ts | run-lifecycle |
| 2 | Not calling observer.complete() after RUN_FINISHED | CRITICAL | mastra integration | — |
| 3 | Returning plain value instead of Observable | CRITICAL | docs/concepts/agents.mdx | — |
| 4 | RUN_FINISHED with active messages or tool calls | HIGH | verify/verify.ts | run-lifecycle |
| 5 | Not handling async errors inside Observable | HIGH | mastra integration | — |
| 6 | Over-implementing all methods without user context | HIGH | maintainer interview | capability-events |

### http-agent-setup (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Missing Accept header for SSE | MEDIUM | http.ts | event-encoding |
| 2 | Calling abortRun() twice | MEDIUM | http.ts | — |
| 3 | Not providing threadId and runId | MEDIUM | docs | — |

### text-message-events (4 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Empty delta in TEXT_MESSAGE_CONTENT | HIGH | events.ts | — |
| 2 | Missing messageId in first CHUNK | CRITICAL | transform.ts | — |
| 3 | Mismatched messageId between START and CONTENT | HIGH | verify.ts | — |
| 4 | Mixing CHUNK with explicit START/CONTENT/END | HIGH | docs | — |

### tool-calling-events (5 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Tool arguments as parsed object instead of JSON string | CRITICAL | docs/tools.mdx | — |
| 2 | Missing toolCallName in first TOOL_CALL_CHUNK | CRITICAL | transform.ts | — |
| 3 | Starting same toolCallId twice | HIGH | verify.ts | — |
| 4 | OpenAI tool description exceeds 1024 chars | MEDIUM | docs/tools.mdx | — |
| 5 | TOOL_CALL_RESULT without matching toolCallId | HIGH | docs/tools.mdx | — |

### human-in-the-loop (2 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Agent executing tool instead of frontend | HIGH | docs/tools.mdx | tool-calling-events |
| 2 | Not returning tool result to agent | HIGH | docs/tools.mdx | tool-calling-events |

### capability-events (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Setting unsupported capabilities to false instead of omitting | MEDIUM | docs/capabilities.mdx | — |
| 2 | Static capabilities for dynamic agent | MEDIUM | docs/capabilities.mdx | — |
| 3 | Forgetting getCapabilities is optional | MEDIUM | agent.ts | — |

### reasoning-events (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Using deprecated THINKING_* events | HIGH | docs/events.mdx | — |
| 2 | Not pairing REASONING_START with END | HIGH | verify.ts | — |
| 3 | Discarding encryptedValue on subsequent turns | HIGH | docs/reasoning.mdx | — |

### state-synchronization (4 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Merging STATE_SNAPSHOT instead of replacing | CRITICAL | docs/state.mdx | — |
| 2 | Applying STATE_DELTA to wrong base state | HIGH | docs/state.mdx | — |
| 3 | Invalid JSON Pointer path in delta | HIGH | docs/state.mdx | — |
| 4 | Assuming messages reset each run | HIGH | docs/events.mdx | run-lifecycle |

### middleware (4 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Expecting middleware to run in connectAgent() | HIGH | docs/middleware.mdx | — |
| 2 | FilterToolCallsMiddleware blocking execution | HIGH | docs/middleware.mdx | tool-calling-events |
| 3 | Wrong middleware execution order assumption | MEDIUM | agent.ts | — |
| 4 | Blocking operations in middleware | MEDIUM | docs/middleware.mdx | — |

### activity-events (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Forwarding activity messages to agent | HIGH | docs/messages.mdx | — |
| 2 | Ignoring replace flag on ACTIVITY_SNAPSHOT | MEDIUM | docs/events.mdx | — |
| 3 | Activity messages lost across MESSAGES_SNAPSHOT | MEDIUM | default.ts | state-synchronization |

### run-lifecycle (4 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Events after RUN_ERROR | CRITICAL | verify.ts | — |
| 2 | Non-RUN_STARTED events after RUN_FINISHED | HIGH | verify.ts | — |
| 3 | Unbalanced STEP_STARTED/STEP_FINISHED | MEDIUM | verify.ts | — |
| 4 | Starting new run without finishing current one | HIGH | verify.ts | — |

### custom-and-raw-events (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Using CUSTOM events for standard protocol features | MEDIUM | docs/events.mdx | — |
| 2 | Assuming RAW event structure | MEDIUM | docs/events.mdx | — |
| 3 | Missing name field on CUSTOM event | MEDIUM | events.ts | — |

### serialization (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Compacting before run completion | MEDIUM | docs/serialization.mdx | — |
| 2 | Losing activity messages during compaction | MEDIUM | default.ts | activity-events |
| 3 | Not normalizing input on branched runs | MEDIUM | docs/serialization.mdx | — |

### event-encoding (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Wrong Accept header causing wrong encoding | HIGH | docs/quickstart/server.mdx | http-agent-setup |
| 2 | Missing Content-Type in response | HIGH | docs/quickstart/server.mdx | — |
| 3 | Encoding events without proper event type field | HIGH | events.ts | — |

### generative-ui (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Confusing AG-UI with a generative UI spec | HIGH | docs/generative-ui-specs.mdx | — |
| 2 | Large UI descriptions reducing agent performance | MEDIUM | docs/generative-ui-specs.mdx | — |
| 3 | Using tool calls for generative UI instead of specs | MEDIUM | docs/generative-ui-specs.mdx | — |

## Tensions

| Tension | Skills | Agent implication |
| ------- | ------ | ----------------- |
| Simplicity vs protocol completeness | implement-abstract-agent <-> run-lifecycle | Agent skips RUN_STARTED or TEXT_MESSAGE_END, causing verifier errors |
| Chunk convenience vs explicit control | text-message-events <-> tool-calling-events | Messages auto-close when using CHUNKs; mixing patterns causes double-init |
| Snapshot bandwidth vs delta precision | state-synchronization <-> serialization | Snapshots waste bandwidth; deltas risk corruption if misordered |
| Middleware filtering vs upstream execution | middleware <-> tool-calling-events | FilterToolCallsMiddleware filters events but LLM still executes tools |

## Cross-References

| From | To | Reason |
| ---- | -- | ------ |
| implement-abstract-agent | run-lifecycle | Every agent must emit correct lifecycle events |
| implement-abstract-agent | text-message-events | Most agents emit text as primary output |
| implement-abstract-agent | middleware | Middleware wraps agent.run() |
| text-message-events | tool-calling-events | Text and tool calls interleave in same run |
| tool-calling-events | human-in-the-loop | HITL is implemented via tool calls |
| state-synchronization | run-lifecycle | State evolves across sequential runs |
| state-synchronization | serialization | Compaction collapses delta chains to snapshots |
| reasoning-events | capability-events | Must declare ReasoningCapabilities |
| event-encoding | http-agent-setup | HttpAgent uses encoder for content negotiation |
| activity-events | state-synchronization | Activities preserved during MESSAGES_SNAPSHOT |
| generative-ui | custom-and-raw-events | UI payloads transported via CUSTOM events |
| middleware | tool-calling-events | FilterToolCallsMiddleware targets tool events |

## Subsystems & Reference Candidates

| Skill | Subsystems | Reference candidates |
| ----- | ---------- | -------------------- |
| implement-abstract-agent | — | — |
| http-agent-setup | — | — |
| text-message-events | — | — |
| tool-calling-events | — | JSON Schema parameter patterns |
| capability-events | — | 12 capability categories with nested fields |
| state-synchronization | — | JSON Patch operations (6 op types) |
| event-encoding | SSE text encoder, Protobuf binary encoder | — |
| generative-ui | A2UI, Open-JSON-UI, MCP-UI | — |

## Remaining Gaps

All gaps resolved during maintainer interview. Key resolutions:
- **implement-abstract-agent**: Added AI-agent-specific failure mode for over-implementation
- **human-in-the-loop**: Interrupt/resume is draft, excluded from skills. Stable HITL is tool-call-based only
- **generative-ui**: No recommended default spec — depends on use case
- **event-encoding**: SSE is the recommended default for most use cases
- **serialization**: Compaction API is stable and production-ready
- **middleware**: connectAgent() middleware support status uncertain

## Recommended Skill File Structure

- **Core skills:** implement-abstract-agent, http-agent-setup, text-message-events, tool-calling-events, run-lifecycle, state-synchronization, custom-and-raw-events, event-encoding, middleware, serialization, capability-events, reasoning-events, activity-events, human-in-the-loop
- **Framework skills:** none (AG-UI is framework-agnostic; integrations have their own patterns)
- **Lifecycle skills:** none warranted (no distinct getting-started or migration journey)
- **Composition skills:** generative-ui
- **Reference files:** capability-events (12 categories), state-synchronization (JSON Patch ops), tool-calling-events (JSON Schema)

## Composition Opportunities

| Library | Integration points | Composition skill needed? |
| ------- | ------------------ | ------------------------- |
| CopilotKit | Primary UI consumer; useCopilotAction for tools, useCoAgent for state | No — CopilotKit has its own docs |
| RxJS | Observable return type from run(), middleware pipeline | No — core dependency, not integration |
| fast-json-patch | STATE_DELTA application | No — internal dependency |
| LangGraph | Server-side integration via Python | No — separate integration package |
| Mastra | Server-side integration via TypeScript | No — separate integration package |
