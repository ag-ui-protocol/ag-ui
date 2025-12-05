## ADR‑0019: Implementation Guidance – Engram Subscription Tasks as System Tasks

**Status:** Accepted
**Date:** 2025‑12‑05

### Context

Engram subscriptions reuse A2A Tasks & Artifacts for streaming, but they differ from "normal" workflow Tasks:

* They are often long‑lived and primarily I/O‑bound.
* They emit potentially high‑volume streams of small events.
* They may be created and forgotten by UIs, risking orphaned subscriptions if not managed carefully.

Without additional guidance, operators might:

* Treat subscription Tasks as regular workflow Tasks and retain them indefinitely.
* Accidentally index every EngramEvent as a first‑class artifact, driving up storage and index costs.

### Decision

1. **Engram subscription Tasks are considered "system Tasks" rather than end‑user workflow Tasks.**

   * Implementations SHOULD mark these Tasks with a recognizable type or metadata flag (e.g. `task.kind = "engram_subscription"`).
   * UIs MAY group or hide them by default in end‑user views, while still exposing them in admin / debug tooling.

2. **Retention and indexing for subscription Tasks SHOULD be tuned for streaming use cases.**

   * Default behavior MAY include:

     * shorter retention windows for artifacts,
     * limited or no full‑text indexing of individual EngramEvents,
     * periodic compaction (e.g. summary artifacts replacing older detailed ones).

3. **Subscription Task creation SHOULD be cheap and reversible.**

   * Implementations SHOULD encourage patterns where:

     * UIs freely create subscription Tasks for views/dashboards, and
     * the system aggressively tears them down when no longer needed (idle/TTL/explicit cancel).

4. **Monitoring SHOULD track subscription Task counts and resource usage.**

   * Operators SHOULD be able to see:

     * number of active Engram subscription Tasks,
     * event rates,
     * storage and CPU impact.

   * This enables tuning timeouts and retention policies in production.

### Consequences

* Engram subscriptions remain a natural fit with A2A Tasks while avoiding unbounded growth.
* Operators have clear guidance that these Tasks are a distinct class with different SLOs and retention needs.
* UIs and tools can treat Engram subscription Tasks specially without changing the core Engram or A2A specs.

---

