## ADR‑0014: Engram as Domain State Extension Over A2A

**Status:** Accepted
**Date:** 2025‑12‑05

### Context

A2A already provides:

* **Contexts**: long‑lived logical conversations/sessions.
* **Tasks**: stateful units of work or streams within a context.
* **Messages & Artifacts**: immutable snapshots of exchanges and outputs for Tasks.

This gives us a **task‑ and context‑local event log**, but A2A deliberately does **not** define a model for long‑lived domain records (e.g. workflow configs, strategy performance, user prefs) that:

* Outlive individual Tasks,
* Are addressable by stable keys,
* Support read/update/query/subscription semantics.

We need a way to expose such domain state through A2A, *without* overloading Tasks/Artifacts with DB semantics or making A2A itself responsible for durable, queryable domain storage.

### Decision

1. **Engram is a separate A2A extension whose purpose is “domain state over A2A”.** It does **not** change core Task semantics.

2. **Canonical domain state lives outside A2A**, in a store controlled by the Engram implementation (DB, LangGraph store, KV, etc.).

   * For long‑lived records (e.g. workflow settings, global performance metrics), **Engram’s store is the system of record**.
   * Tasks & Artifacts are projections/log entries that *reflect* those records at points in time.

3. **Task/Artifact history is treated as:**

   * **Authoritative for “what happened & when”** (event log, audit, debugging), and
   * **Secondary for “what is the current value?”** of long‑lived records.

   We do **not** require that current domain state be reconstructible from Tasks alone.

4. **Thread/context‑local state** can be implemented in either of two ways:

   * Pure A2A: using Task messages/metadata/artifacts only (no Engram), where we only need ephemeral, task‑scoped state.
   * Engram: when we want explicitly keyed, queryable state even within a context.

5. Engram is layered on top of A2A using:

   * **Extension‑specific JSON‑RPC methods** (the `engram/*` API), and
   * **Optional Engram payloads** embedded in messages/artifacts.

6. **Engram subscriptions use A2A Tasks & Artifacts as their streaming transport**, with Engram defining the data shape of events and how they map onto Task artifacts (see ADR‑0017).

### Consequences

* We preserve A2A’s clean separation: protocol concerns vs app/domain concerns.
* We can treat Engram’s store as a **first‑class domain database** with its own durability, indexing, and query behavior.
* Tasks remain focused on workflows, coordination, and projections, not on storing “the DB”.
* For streaming, we reuse A2A’s Task/Artifact machinery instead of inventing a parallel push channel.

---

