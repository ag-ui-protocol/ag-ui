# ADR 0003: Run Invocation Modes (send vs stream)

**Status**  
Accepted

**Date**  
2025-11-29

## Context

We need a unified Run API that maps cleanly to A2A message.send and message.stream while covering new and existing Tasks.

## Decision

- Expose RunOptions with `mode: "send" | "stream"`, `threadId`, optional `taskId`, optional `message` (A2A-shaped), and optional `state`.
- `mode: "stream", taskId: undefined` → A2A `message.stream` creates a new Task and a long-lived AG-UI Run subscription.
- `mode: "send", taskId: undefined` → A2A `message.send` creates a new Task and returns when the Task reaches completion; the Run is short-lived or synchronous.
- `mode: "send", taskId: existing` → A2A `message.send` as injection/control; short-lived control Run, while the subscription Run for that Task stays open.
- `mode: "stream", taskId: existing` → optional secondary subscription to an existing Task.
- For backwards compatibility, `mode: "send", taskId: undefined` mirrors the current one-shot behavior (single message, blocking or short-lived run); richer modes add streaming/subscription without changing that baseline.

## Consequences

- Clear mapping between UI invocation modes and A2A semantics.
- Supports both synchronous one-offs and long-lived streaming jobs.
- Enables injections without disrupting primary subscriptions.
