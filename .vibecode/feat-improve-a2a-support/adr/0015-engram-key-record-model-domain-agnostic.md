## ADR‑0015: Engram Key & Record Model (Domain‑Agnostic)

**Status:** Accepted
**Date:** 2025‑12‑05

### Context

We need a way to uniquely address domain records (configs, metrics, profiles, etc.) that:

* Works across many domains (trading, CRM, devtools, etc.),
* Does **not** bake in domain‑specific scopes like “strategy” or “user” into the *spec*,
* Still supports filtering, listing, and subscription.

Earlier drafts proposed structured fields like `space`, `ownerType`, and `ownerId`. These are useful as **conventions**, but they are not standardized, and they prematurely bake application semantics into the Engram core.

### Decision

1. **Engram keys are minimal, domain‑agnostic identifiers:**

```ts
interface EngramKey {
  // Canonical identifier string for a record within an Engram store.
  key: string;

  // Optional opaque metadata for filtering or routing.
  // Semantics are application/profile‑defined, not spec‑defined.
  labels?: Record<string, string>;
}
```

* `key` MUST be unique within the Engram store.
* `key` MAY follow any convention (e.g. "config/workflow/wf:123/settings", "metrics/strategy/eth-usdc/performance").
* `labels` are optional and opaque to the spec; they allow applications to expose structured metadata (e.g. `{ "space": "config", "ownerType": "workflow", "ownerId": "wf:123" }`) without hardcoding those concepts into Engram.

2. **Engram records are versioned JSON blobs keyed by EngramKey:**

```ts
interface EngramRecord {
  key: EngramKey;
  value: unknown;      // arbitrary JSON, application‑defined
  version: number;     // monotonically increasing per logical key
  createdAt: string;   // ISO‑8601
  updatedAt: string;   // ISO‑8601
  tags?: string[];     // optional labels for querying/search
}
```

3. **Version semantics:**

   * `version` is **monotonic per `key`**; every successful write increments it by at least 1.
   * Writes MAY support optimistic concurrency via `expectedVersion` (see ADR‑0016).
   * Version is Engram‑level, not tied to any specific Task.

4. **Domain‑specific shaping is explicitly out of scope of the core spec.**

   * Individual apps/frameworks can publish their own **Engram profiles** that recommend:

     * specific key path/label conventions (e.g. "config/workflow/wf:123/settings"),
     * JSON schemas for `value` for particular keys or key prefixes.

### Consequences

* Engram spec stays reusable across domains.
* We can still express “what we meant by ‘global’/‘user’/‘strategy’” at the *profile* layer, not the spec layer.
* Querying and subscription can be expressed in terms of `key` (and optionally `labels`/`tags`) without hardcoding domain semantics.

---

