# Architecture Decision Log

Branch: feat/improve-a2a-support

| ID | Title | Status | Date | Path |
| --- | --- | --- | --- | --- |
| ADR 0001 | Interface Surfaces (A2A vs AG-UI vs REST) | Accepted | 2025-11-29 | .vibecode/feat-improve-a2a-support/adr/0001-interface-surfaces.md |
| ADR 0002 | Run <-> Task Mapping | Accepted | 2025-11-29 | .vibecode/feat-improve-a2a-support/adr/0002-run-task-mapping.md |
| ADR 0003 | Run Invocation Modes (send vs stream) | Accepted | 2025-11-29 | .vibecode/feat-improve-a2a-support/adr/0003-run-modes.md |
| ADR 0004 | Canonical Input as Messages | Accepted | 2025-11-29 | .vibecode/feat-improve-a2a-support/adr/0004-canonical-input-messages.md |
| ADR 0005 | Config/Control via Engram Extension | Superseded by ADR 0014 & 0020 | 2025-11-29 | .vibecode/feat-improve-a2a-support/adr/0005-engram-extension.md |
| ADR 0006 | AG-UI Shared State as Projection | Accepted | 2025-11-29 | .vibecode/feat-improve-a2a-support/adr/0006-ag-ui-state-projection.md |
| ADR 0007 | Metadata Layering (Keep AG-UI Details Internal) | Accepted | 2025-11-29 | .vibecode/feat-improve-a2a-support/adr/0007-metadata-layering.md |
| ADR 0008 | LLM Lane vs Config Lane | Accepted | 2025-11-29 | .vibecode/feat-improve-a2a-support/adr/0008-llm-vs-config-lanes.md |
| ADR 0009 | Audit, Replay, and Multi-Agent Consistency | Accepted | 2025-11-29 | .vibecode/feat-improve-a2a-support/adr/0009-audit-replay-consistency.md |
| ADR 0010 | A2A -> AG-UI Shared State via Tasks and Artifacts | Accepted (amended by ADR 0016/0018) | 2025-11-29 | .vibecode/feat-improve-a2a-support/adr/0010-artifacts-to-shared-state.md |
| ADR 0011 | Implicit vs Explicit Semantics for A2A Agents | Accepted | 2025-11-29 | .vibecode/feat-improve-a2a-support/adr/0011-implicit-vs-explicit-semantics.md |
| ADR 0012 | Input Interrupts via A2A `input_required` + AG-UI Activity/State | Accepted | 2025-12-01 | .vibecode/feat-improve-a2a-support/adr/0012-hitl-activity-interrupts.md |
| ADR 0013 | Stateless A2A Bridge | Accepted | 2025-12-03 | .vibecode/feat-improve-a2a-support/adr/0013-stateless-bridge.md |
| ADR 0014 | Engram as Domain State Extension Over A2A | Accepted | 2025-12-05 | .vibecode/feat-improve-a2a-support/adr/0014-engram-as-domain-state-extension-over-a2a.md |
| ADR 0015 | Engram Key & Record Model (Domain-Agnostic) | Accepted | 2025-12-05 | .vibecode/feat-improve-a2a-support/adr/0015-engram-key-record-model-domain-agnostic.md |
| ADR 0016 | JSON Patch & Engram API Surface | Accepted | 2025-12-05 | .vibecode/feat-improve-a2a-support/adr/0016-json-patch-engram-api-surface.md |
| ADR 0017 | Engram Streaming via Tasks & Artifacts | Accepted | 2025-12-05 | .vibecode/feat-improve-a2a-support/adr/0017-engram-streaming-via-tasks-artifacts.md |
| ADR 0018 | Dual Integration – Engram Methods & Message-Embedded Operations | Accepted | 2025-12-05 | .vibecode/feat-improve-a2a-support/adr/0018-dual-integration-engram-methods-message-embedded-operations.md |
| ADR 0019 | Implementation Guidance – Engram Subscription Tasks as System Tasks | Accepted | 2025-12-05 | .vibecode/feat-improve-a2a-support/adr/0019-implementation-guidance-engram-subscription-tasks-as-system-tasks.md |
| ADR 0020 | Engram A2A Extension URI & Activation | Accepted | 2025-12-05 | .vibecode/feat-improve-a2a-support/adr/0020-engram-a2a-extension-uri-activation.md |
