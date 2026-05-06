# @ag-ui/core CHANGELOG

## 0.1.0

### BREAKING CHANGES

- `zod` is no longer a runtime dependency of `@ag-ui/core`. The package's main entry now ships only TypeScript types, value-level constants (`EventType`), error classes (`AGUIError`, `AGUIConnectNotImplementedError`), and event factories. No `*Schema` exports.
- The zod schemas have moved to a new opt-in subpath: `@ag-ui/core/schemas`. zod is now an optional peer dependency — install it explicitly if you import from this module. This lets consumers control which zod major they use, eliminating the v3/v4 dual-installation conflicts that this change is designed to fix.
- The internal `BinaryInputContentSchema` runtime check moved from `superRefine` to `.refine()`. The boolean validation is unchanged; the precise error path (`["id"]`) is no longer reported.

### Migration

```ts
// Before
import { UserMessageSchema } from "@ag-ui/core";

// After — option A (most users)
import { UserMessageSchema } from "@ag-ui/core/schemas";

// After — option B (BYO validator)
import { fromStandardSchema, type AgentValidator } from "@ag-ui/core";
import { z } from "zod"; // any zod major, or valibot, arktype, etc.
const myValidator: AgentValidator = {
  validateEvent: fromStandardSchema(/* your event schema */),
};
```

### Features

- Added `AgentValidator` interface based on [Standard Schema](https://github.com/standard-schema/standard-schema). Zero-runtime types-only dependency.
- Added `fromStandardSchema(schema)` helper for adapting any Standard-Schema-compliant validator (zod 3.24+, zod 4, valibot, arktype, effect/schema) into an `AgentValidator`.
- Added `zodValidator` (exported from `@ag-ui/core/schemas`) as a drop-in default validator backed by `EventSchemas`.
- `transformHttpEventStream` (`@ag-ui/client`) and the protobuf encoder/decoder (`@ag-ui/proto`) accept an optional `AgentValidator` parameter; default is `zodValidator` from the schemas subpath, preserving the prior runtime-validation behavior with no caller changes required.
