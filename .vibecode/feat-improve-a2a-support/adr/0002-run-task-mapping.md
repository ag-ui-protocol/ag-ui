# ADR 0002: Run <-> Task Mapping

**Status**  
Proposed

**Date**  
2025-11-29

## Context

Long-lived workflows need a stable mapping between AG-UI Runs and A2A Tasks while supporting mid-flight injections and reconnect/resubscribe flows.

## Decision

- Treat one long-lived A2A Task as mapped to one long-lived AG-UI Run subscription; the Run streams Task updates for the Task’s non-terminal life.
- Mid-flight injections are new Messages on the same Task, sent via short-lived control Runs; the long-lived subscription Run stays open.
- On reconnect, start a new Run and resync via StateSnapshot/MessagesSnapshot/ActivitySnapshot rather than reopening the old Run.

## Consequences

- Supports continuous jobs with uninterrupted streaming and provenance.
- Keeps injections lightweight while preserving a single Task timeline.
- Reconnect semantics rely on snapshots, avoiding fragile run resurrection.

