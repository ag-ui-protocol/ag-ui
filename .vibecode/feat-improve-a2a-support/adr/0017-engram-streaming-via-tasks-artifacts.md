## ADR‑0017: Engram Streaming via Tasks & Artifacts

**Status:** Accepted
**Date:** 2025‑12‑05

### Context

We need:

* A way to subscribe to changes in Engram records (for dashboards, UIs, other agents).
* A way to resume after disruption, reusing A2A’s existing streaming semantics where possible.
* To avoid inventing a parallel push channel when A2A already has Tasks & Artifacts.

Earlier drafts introduced both `subscriptionId` and `taskId` plus a separate `engram/resubscribe`. This added complexity without clear benefit if we are comfortable treating the Task itself as the subscription identity.

### Decision

1. **`engram/get` is one‑shot and does NOT create a subscription or Task.**

   * It returns record snapshots as per ADR‑0016.
   * It is the Engram equivalent of a "REST GET".

2. **`engram/subscribe` creates a dedicated "Engram subscription Task" and streams updates via Artifacts.**

   **Request:**

   ```ts
   interface EngramSubscribeParams {
     filter: EngramFilter;          // which records to watch
     includeSnapshot?: boolean;     // if true, send initial snapshots
     contextId?: string;            // A2A context to associate with this subscription

     // Optional replay control: start streaming from a known Engram sequence
     fromSequence?: string;         // e.g. last-seen EngramEvent.sequence
   }
   ```

   **Response:**

   ```ts
   interface EngramSubscribeResult {
     taskId: string;                // underlying A2A Task used for streaming
   }
   ```

   **Server behavior:**

   * Creates a new Task (or uses a specialized Task type) associated with the given `contextId` (or a default context if omitted).
   * That Task emits `TaskArtifactUpdateEvent`s over the usual A2A streaming channel.
   * Each artifact for this Task contains **Engram events** in its `DataPart`s.

3. **Engram events are delivered as artifacts with a well‑known data shape.**

   ```ts
   interface EngramEvent {
     kind: "snapshot" | "delta" | "delete";
     key: EngramKey;
     record?: EngramRecord; // for snapshot
     patch?: JsonPatch;     // for delta
     version: number;
     sequence: string;      // monotonically increasing per key or subscription scope
     updatedAt: string;     // ISO‑8601
   }
   ```

   On the wire, each event is a `DataPart` inside an Artifact for the subscription Task:

   ```json
   {
     "kind": "data",
     "data": {
       "type": "engram/event",
       "event": { /* EngramEvent as above */ }
     }
   }
   ```

   * For `includeSnapshot=true`, the first artifact(s) SHOULD include `kind: "snapshot"` events for all matching records, ordered in a deterministic but implementation‑defined way.

4. **Resubscribe uses the existing A2A Task APIs.**

   * Engram does **not** define a separate `engram/resubscribe` or `subscriptionId`.

   * Clients that lose their streaming connection SHOULD:

     1. Reattach using `tasks/resubscribe(taskId, ...)` if the Task is still active.
     2. If the Task has terminated or history limits prevent replay, call `engram/subscribe` again, optionally providing a `fromSequence` equal to the last processed `EngramEvent.sequence`.

   * This keeps Engram simple while still allowing robust resume semantics using primitives the A2A platform already defines.

5. **Subscription Task lifecycle is explicit to avoid zombies.**

   Subscription Tasks MUST eventually reach a terminal state. Implementations MUST ensure that:

   * A subscription Task terminates when:

     * The client explicitly cancels it via `tasks/cancel(taskId)`, **or**
     * A configured idle timeout elapses (implementation-defined), **or**
     * A configured maximum duration elapses (implementation-defined), **or**
     * A fatal error occurs in the Engram store or subscription machinery.

   * When a subscription Task terminates, the server SHOULD emit a final Artifact or status indicating the reason (e.g. `"reason": "cancelled" | "idle_timeout" | "ttl" | "error"`).

   * Implementations MAY automatically cancel subscription Tasks when the last observing connection for a given client or context disconnects, as long as this behavior is documented.

6. **Retention and indexing for subscription Tasks may be specialized.**

   To avoid storage/index bloat for hot streams:

   * Implementations MAY:

     * apply shorter retention to subscription Task artifacts,
     * avoid heavy indexing of individual EngramEvents,
     * periodically summarize or compact older artifacts.

   * These policies are implementation‑specific but SHOULD be documented so operators understand durability guarantees for subscription history.

### Consequences

* We reuse A2A’s Task streaming model instead of inventing a new push channel.
* Subscriptions have a **single identity** (`taskId`), reducing conceptual complexity.
* Clients can use familiar A2A APIs (`tasks/resubscribe`, `tasks/cancel`) to manage Engram subscriptions.
* Explicit lifecycle rules prevent long‑lived zombie Tasks and make Engram’s operational behavior predictable.

---

