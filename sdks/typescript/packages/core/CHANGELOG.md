# @ag-ui/core CHANGELOG

## 1.0.0

### BREAKING CHANGES

- The deprecated `THINKING_*` events are removed. The `EventType.THINKING_*` enum members, the `Thinking*Event` types, the `Thinking*EventSchema` schemas, and the `createThinking*` factories no longer exist. Use the `REASONING_*` events instead — each maps 1:1 (`THINKING_START` → `REASONING_START`, `THINKING_TEXT_MESSAGE_START` → `REASONING_MESSAGE_START`, `THINKING_TEXT_MESSAGE_CONTENT` → `REASONING_MESSAGE_CONTENT`, `THINKING_TEXT_MESSAGE_END` → `REASONING_MESSAGE_END`, `THINKING_END` → `REASONING_END`). `@ag-ui/client` still transparently rewrites legacy `THINKING_*` wire events from `maxVersion <= 0.0.45` agents to their `REASONING_*` equivalents, so existing agents keep working.
- The deprecated `BinaryInputContent` multimodal input (`type: "binary"`) is removed — the `BinaryInputContent` type, `BinaryInputContentSchema`, and its membership in `InputContentSchema` no longer exist. Use the dedicated `ImageInputContent` / `AudioInputContent` / `VideoInputContent` / `DocumentInputContent` types with a `source: { type: "data" | "url", ... }` discriminator. `@ag-ui/client` upgrades legacy binary parts to the new types on outgoing input (data/url parts are converted; `id`-only parts are dropped with a warning), so apps still sending binary keep working.

### Migration

See the [1.0.0 migration guide](https://docs.ag-ui.com/sdk/js/core/migration-1-0-0).

## 0.1.0

### BREAKING CHANGES

- `zod` is no longer a runtime dependency of `@ag-ui/core`. The package's main entry now ships only TypeScript types, value-level constants (`EventType`), error classes (`AGUIError`, `AGUIConnectNotImplementedError`), and event factories. No `*Schema` exports.
- The zod schemas have moved to a new opt-in subpath: `@ag-ui/core/schemas`. zod is an optional peer dependency on the subpath, accepting `^3.24.0 || ^4.0.0` — install whichever major you prefer.
- The internal `BinaryInputContentSchema` runtime check moved from `superRefine` to `.refine()`. Boolean validation is unchanged; the precise error path (`["id"]`) is no longer reported.

### Migration

```ts
// Before
import { UserMessageSchema } from "@ag-ui/core";

// After
import { UserMessageSchema } from "@ag-ui/core/schemas";
```

### Internal package changes

- `@ag-ui/client` and `@ag-ui/proto` now declare `zod` as a regular dependency and import `EventSchemas` from `@ag-ui/core/schemas` to validate incoming events. No public API change for consumers of these packages.
