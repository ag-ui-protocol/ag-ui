## ADR‑0016: JSON Patch & Engram API Surface

**Status:** Accepted
**Date:** 2025‑12‑05

### Context

We need:

* A standard way to represent **partial updates** to Engram records.
* A small set of **Engram RPC methods** that feel familiar to A2A users (similar to `tasks/get`/`tasks/list`), plus mutations.
* A basis for streaming updates (subscribe) that can be replayed or resumed.

JSON Patch (RFC 6902) is a widely used standard for describing changes to JSON documents.

### Decision

#### 1. JSON Patch as the Engram delta format

* Engram MUST use **JSON Patch** (RFC 6902) to represent partial updates to `record.value`.
* A patch is a standard JSON Patch document:

```ts
type JsonPatch = Array<{
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
}>;
```

* Patches are always applied to the **`value` field** of the EngramRecord for a given `key`.
* Metadata (`version`, timestamps, tags) is updated implicitly by the Engram store as part of handling the patch.

#### 2. Engram RPC methods

Engram defines the following JSON‑RPC methods (names are logical; exact method naming/namespace may vary, but semantics are stable):

1. **`engram/get`** – one‑shot snapshot fetch

   **Purpose:** Fetch one or more full record snapshots.

   **Request (simplified):**

   ```ts
   interface EngramFilter {
     keyPrefix?: string;
     updatedAfter?: string; // ISO‑8601
   }

   interface EngramGetParams {
     key?: EngramKey;           // exact key
     keys?: EngramKey[];        // multiple exact keys
     filter?: EngramFilter;     // optional broader filter
   }
   ```

   **Response:**

   ```ts
   interface EngramGetResult {
     records: EngramRecord[];
   }
   ```

   `engram/get` is **non‑streaming** (one‑shot RPC).

2. **`engram/list`** – list records with pagination

   **Purpose:** List records matching a filter.

   **Request:**

   ```ts
   interface EngramListParams {
     filter?: EngramFilter;
     pageSize?: number;
     pageToken?: string;
   }
   ```

   **Response:**

   ```ts
   interface EngramListResult {
     records: EngramRecord[];
     nextPageToken?: string;
   }
   ```

3. **`engram/set`** – full upsert

   **Purpose:** Create or replace the entire `value` for a key.

   **Request:**

   ```ts
   interface EngramSetParams {
     key: EngramKey;
     value: unknown;
     expectedVersion?: number; // optional CAS
     tags?: string[];          // optional new tags
   }
   ```

   **Response:**

   ```ts
   interface EngramSetResult {
     record: EngramRecord; // new snapshot with incremented version
   }
   ```

   If `expectedVersion` is provided and does not match the current version, the call MUST fail with a version conflict error.

4. **`engram/patch`** – JSON Patch mutation

   **Purpose:** Apply JSON Patch to an existing record.

   **Request:**

   ```ts
   interface EngramPatchParams {
     key: EngramKey;
     patch: JsonPatch;
     expectedVersion?: number;
   }
   ```

   **Response:**

   ```ts
   interface EngramPatchResult {
     record: EngramRecord; // snapshot after patch, new version
   }
   ```

   If record does not exist, or `expectedVersion` mismatches, the call MUST fail.

5. **`engram/delete`** – delete record

   **Purpose:** Delete a record.

   **Request:**

   ```ts
   interface EngramDeleteParams {
     key: EngramKey;
     expectedVersion?: number;
   }
   ```

   **Response:**

   ```ts
   interface EngramDeleteResult {
     deleted: boolean;
     previousVersion?: number;
   }
   ```

### Consequences

* JSON Patch gives Engram a compact, standardized, and widely supported delta format.
* The API surface feels familiar to A2A users (get/list like tasks, plus set/patch/delete).
* We explicitly support optimistic concurrency and history inspection.

---

