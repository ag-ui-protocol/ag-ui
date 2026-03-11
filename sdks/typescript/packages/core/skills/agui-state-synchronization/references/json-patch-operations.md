# JSON Patch Operations Reference (RFC 6902)

AG-UI `STATE_DELTA` events carry an array of JSON Patch operations. Each operation is applied in order to the current state document.

All paths use JSON Pointer syntax (RFC 6901): segments separated by `/`, starting with `/`. Array elements are addressed by numeric index (e.g., `/items/0`). Special characters `~` and `/` in key names are escaped as `~0` and `~1`.

## Operation 1: add

Adds a value at the target location. If the path points to an existing object key, it inserts a new key. If the path targets an array index, it inserts before that index.

```json
{ "op": "add", "path": "/user/preferences", "value": { "theme": "dark" } }
```

Before: `{ "user": {} }`
After: `{ "user": { "preferences": { "theme": "dark" } } }`

Array insert example:

```json
{ "op": "add", "path": "/tags/1", "value": "urgent" }
```

Before: `{ "tags": ["low", "normal"] }`
After: `{ "tags": ["low", "urgent", "normal"] }`

Use `/tags/-` to append to the end of an array:

```json
{ "op": "add", "path": "/tags/-", "value": "new-tag" }
```

Before: `{ "tags": ["a", "b"] }`
After: `{ "tags": ["a", "b", "new-tag"] }`

## Operation 2: remove

Removes the value at the target location. The path must exist or the operation fails.

```json
{ "op": "remove", "path": "/temporary_data" }
```

Before: `{ "temporary_data": { "cache": "..." }, "permanent": true }`
After: `{ "permanent": true }`

Array element removal:

```json
{ "op": "remove", "path": "/items/2" }
```

Before: `{ "items": ["a", "b", "c", "d"] }`
After: `{ "items": ["a", "b", "d"] }`

## Operation 3: replace

Replaces the value at the target location. The path must already exist (unlike `add`).

```json
{ "op": "replace", "path": "/status", "value": "completed" }
```

Before: `{ "status": "in-progress" }`
After: `{ "status": "completed" }`

Replacing a nested value:

```json
{ "op": "replace", "path": "/user/preferences/theme", "value": "light" }
```

Before: `{ "user": { "preferences": { "theme": "dark" } } }`
After: `{ "user": { "preferences": { "theme": "light" } } }`

## Operation 4: move

Removes the value at `from` and adds it at `path`. Equivalent to a `remove` followed by `add`.

```json
{ "op": "move", "from": "/pending/0", "path": "/completed/-" }
```

Before: `{ "pending": ["task-1", "task-2"], "completed": [] }`
After: `{ "pending": ["task-2"], "completed": ["task-1"] }`

## Operation 5: copy

Copies the value at `from` to `path`. The source remains unchanged.

```json
{ "op": "copy", "from": "/defaults/theme", "path": "/user/theme" }
```

Before: `{ "defaults": { "theme": "dark" }, "user": {} }`
After: `{ "defaults": { "theme": "dark" }, "user": { "theme": "dark" } }`

## Operation 6: test

Tests that the value at `path` equals `value`. If the test fails, the entire patch operation is aborted. Use this to guard subsequent operations.

```json
[
  { "op": "test", "path": "/version", "value": 3 },
  { "op": "replace", "path": "/version", "value": 4 }
]
```

If `/version` is `3`, both operations succeed. If `/version` is anything else, neither operation is applied.

## Usage in AG-UI STATE_DELTA

```typescript
import { EventType, type BaseEvent } from "@ag-ui/core";

// Emit a delta with multiple operations applied atomically
subscriber.next({
  type: EventType.STATE_DELTA,
  delta: [
    { op: "test", path: "/version", value: 3 },
    { op: "replace", path: "/version", value: 4 },
    { op: "add", path: "/lastUpdated", value: "2026-03-11T10:00:00Z" },
    { op: "remove", path: "/draft" },
  ],
});
```

## Client-side application

```typescript
import { applyPatch } from "fast-json-patch";

// applyPatch(document, operations, validateOperation, mutateDocument)
// - validateOperation=true: validates each op before applying
// - mutateDocument=false: returns a new document without mutating the original
const result = applyPatch(currentState, deltaOperations, true, false);
const newState = result.newDocument;
```

## Common path pitfalls

| Wrong                       | Correct                    | Issue                              |
|-----------------------------|----------------------------|------------------------------------|
| `user.preferences.theme`   | `/user/preferences/theme`  | Must use `/` not `.`               |
| `preferences/theme`        | `/preferences/theme`       | Must start with `/`                |
| `/items[0]`                | `/items/0`                 | Array indices are path segments    |
| `/keys/a~b`                | `/keys/a~0b`               | `~` must be escaped as `~0`        |
| `/keys/c/d`                | `/keys/c~1d`               | Literal `/` in key escaped as `~1` |
