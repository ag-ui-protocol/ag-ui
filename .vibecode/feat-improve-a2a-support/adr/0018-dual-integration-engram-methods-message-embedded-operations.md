## ADR‑0018: Dual Integration – Engram Methods & Message‑Embedded Operations

**Status:** Accepted
**Date:** 2025‑12‑05

### Context

Some A2A clients:

* Prefer **explicit RPC methods** (`engram/get`, `engram/set`, etc.).
* Others primarily speak in terms of **messages** (`message/send`/`message/stream`) and may want to embed domain‑specific operations in messages that the agent interprets semantically.

For Engram v0.1 we want to:

* Keep the **normative surface area small and sharp**: RPC methods + event shapes.
* Still leave room for message‑embedded Engram operations as an **optional profile** that implementers can experiment with.

### Decision

1. **RPC methods are the canonical and only required Engram interface in v0.1.**

   * The v0.1 spec defines `engram/get`, `engram/list`, `engram/set`, `engram/patch`, `engram/delete`, and `engram/subscribe` as the normative Engram API.
   * Conformance to Engram v0.1 only requires implementing these methods (plus the EngramEvent shape used in subscription Task artifacts).

2. **Message‑embedded Engram operations are an optional, non‑normative profile.**

   * Implementations **MAY** support representing Engram mutations as message‑embedded operations in `DataPart.data`.
   * When they do, the recommended (non‑normative) shape is:

   ```ts
   type EngramOpKind = "get" | "set" | "patch" | "delete";

   interface EngramOperation {
     op: EngramOpKind;
     key?: EngramKey;           // required for set/patch/delete; optional/filter for get
     value?: unknown;           // for set
     patch?: JsonPatch;         // for patch
     filter?: EngramFilter;     // for get/list semantics
     requestId?: string;        // to correlate responses
   }
   ```

   * A2A bindings that choose to support this profile **SHOULD** place the operation under a namespaced container key in `DataPart.data` (for example, `"engram.ops.EngramOperation"`), following the pattern used by other A2A extensions.
   * This profile is explicitly marked **non‑normative** for v0.1. Agents and clients MUST NOT assume that all Engram‑aware peers support message‑embedded operations.

3. **Engram v0.1 does not standardize any `metadata[...]` keys.**

   * Implementations MAY use `message.metadata[ENGRAM_EXTENSION_URI]` for Engram‑specific hints or configuration, but no portable keys are defined in v0.1.
   * Future versions may specify a standard metadata schema if concrete cross‑implementation use cases emerge.

4. **Consumers of Engram updates SHOULD rely on EngramEvents via subscription Tasks.**

   * The single, normative format for "Engram changed" events in v0.1 is the `EngramEvent` carried in subscription Task artifacts as defined in ADR‑0017.
   * Message‑embedded Engram operations MUST be treated as syntactic sugar over the RPC methods when they are implemented.

### Consequences

* Engram v0.1 remains **minimal and focused**: RPC methods + event streaming are the only required pieces.
* Implementers have room to experiment with message‑centric usage without fragmenting the core spec.
* Future versions (e.g. v0.2) can promote parts of the optional profile to normative status once real‑world patterns solidify.

---

