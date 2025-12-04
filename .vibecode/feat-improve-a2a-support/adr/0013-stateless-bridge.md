# ADR 0013: Stateless A2A Bridge

**Status**  
Accepted

**Date**  
2025-12-03

## Context

Recent defects showed the A2A bridge reused client-held tracker state across reconnects and generated local contextIds. This caused repeated interruptIds, missing pending interrupt cleanup, and protocol divergence (server owns contextId/taskId). Prior ADR 0002 mandates reconnects resync from snapshots instead of reviving prior runs; this ADR makes the stateless requirement explicit for the bridge implementation.

## Decision

- Treat each bridge run/connection as stateless: hydrate solely from server-delivered task snapshots + subsequent stream deltas; discard tracker state when the stream ends.
- A2A is the source of truth for contextId and taskId. If the caller supplies a contextId, use it; otherwise omit it and accept the server-generated contextId. Binding happens once per agent instance; the instance keeps that bound threadId/contextId for its lifetime, consistent with AbstractAgent’s contract. To start a new context, construct a new agent instance—no internal multi-context cache.
- For A2A-only scenarios, treat the server contextId as the conversation identifier (`contextId === threadId`) exposed to AG-UI. The caller (UI/orchestrator) persists and reuses that identifier on subsequent calls; the bridge remains stateless in its per-run projection/tracker.
- Derive deterministic interruptIds from server identifiers (taskId + requestId/status messageId) instead of local counters.
- On reconnect/resubscribe, always fetch the task snapshot first, then apply streaming deltas; rebuild pending interrupts and artifacts from snapshot + live events.

## Consequences

- Reconnects and resumes produce consistent projections without cross-run residue.
- Interrupt handling remains deterministic across disconnects; input responses can always match pending entries.
- Bridge behavior stays protocol-compliant: server is the source of truth for contextId/taskId; client never invents them.
- Statelessness is preserved: any persistence of contextId/threadId happens in the caller, not inside the bridge.
- Simpler failure recovery: dropping a connection only requires refetching snapshot + streaming, with no persisted client state to reconcile.

## Notes on first-turn identity

- AG-UI currently treats threadId as required in RunAgentInput, so late-binding threadId to the server contextId requires either deferring threadId assignment for A2A agents or treating the first emitted threadId as authoritative. This is consistent with patterns where the server returns the conversation ID on first call (for example, AGUIChatClient auto-generates and returns thread_id to use on later calls; see Microsoft Learn example¹).

---
¹ https://learn.microsoft.com/zh-cn/python/api/agent-framework-core/agent_framework.ag_ui.aguichatclient?view=agent-framework-python-latest&utm_source=chatgpt.com
