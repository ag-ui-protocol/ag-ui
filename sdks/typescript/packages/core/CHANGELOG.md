# @ag-ui/core CHANGELOG

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
