# @ag-ui/core CHANGELOG

## 0.1.0

### BREAKING CHANGES

- Removed `zod` as a runtime dependency of `@ag-ui/core`. The package now ships only TypeScript types, value-level constants (`EventType`), error classes (`AGUIError`, `AGUIConnectNotImplementedError`), and event factories. No `*Schema` exports.
- Consumers that imported any `*Schema` constant (e.g., `UserMessageSchema`, `EventSchemas`, `AgentCapabilitiesSchema`) must either define their own validation locally or use the new `AgentValidator` interface (see Features below).
- Migration: replace `import { UserMessageSchema } from "@ag-ui/core"` with a locally defined zod (or any-validator) schema.

### Features

- Added `AgentValidator` interface based on [Standard Schema](https://github.com/standard-schema/standard-schema). Zero-runtime types-only dependency.
- Added `defaultEventValidator` — a hand-written validator that performs minimal type-tag checking and applies field defaults (`role` for `TEXT_MESSAGE_START`, `replace` for `ACTIVITY_SNAPSHOT`, `outcome` null normalization for `RUN_FINISHED`).
- Added `fromStandardSchema(schema)` helper for adapting any Standard-Schema-compliant validator (zod 3.24+, zod 4, valibot, arktype, effect/schema, ...) into an `AgentValidator`.
- `transformHttpEventStream` (`@ag-ui/client`) and the protobuf decoder (`@ag-ui/proto`) accept an optional `AgentValidator` parameter; default is `defaultEventValidator`.
