# AG-UI schema semantics

This suite feeds the same boundary cases to the Zod schemas of
`@ag-ui/core@1.0.4` (`@ag-ui/core/schemas`), on `zod@4.6.7`, and the Rust SDK.
npm pins the official SDK and its `zod` peer dependency with an
integrity-checked lockfile.
The Rust probe uses ordinary typed decoding and `RunOutcome::validate()` for its
non-empty interrupt rule. It never substitutes an SDK parser with a test parser.

```sh
npm ci --prefix e2e/interop --ignore-scripts
npm test --prefix e2e/interop
```

The cases cover empty, absent, null and incorrectly typed deltas; default roles;
metadata and attribution; null tool parents and run outcomes; token usage;
unknown outcome fields; and run input. Acceptance must agree with the official
schema, and accepted values must normalize identically. Every exception is a
case in `cases.json` that states its reason in `difference` and pins both
sides, so a change on either side fails the suite.

Acceptance differs in two families (`rustAccepted`):

- An explicit `null` for `TOOL_CALL_START.parentMessageId` or
  `RUN_FINISHED.outcome`. AG-UI 1.0 retired both: its deprecation registry has
  a consumer read them as the omitted field, and the canonical schema rejects
  them. Typed Rust decoding reads them as absent.
- An unknown field on a run or subagent outcome. The 1.0 JSON Schema closes
  those objects and typed Rust outcomes reject the field. The TypeScript parser
  is a loose object that keeps it for its enforcement stage to strip; the Rust
  client boundary strips it with a warning before typed decoding.

Accepted values differ in two more (`rustValue`, `upstreamValue`):

- Typed `Event` decoding ignores unknown top-level fields and unknown fields of
  a token usage entry; the TypeScript schemas are loose objects and preserve
  them. Retain the raw JSON when forwarding unknown extensions, or use the
  protocol's `metadata` field. Typed decoding is not a lossless proxy.
- An absent `TEXT_MESSAGE_START.role` means `assistant` and an absent
  `ACTIVITY_SNAPSHOT.replace` means `true`. Typed Rust events store and
  serialize those defaults; the TypeScript schemas validate without filling
  them in. Both reject an explicit `null`.

Absent input `state` and `forwardedProps` are omitted on serialization. The
cases use non-null values when either field is present; an explicit `null` for
them is not covered here.

These are targeted semantic checks, not a claim that every possible protocol
value has been proven equivalent. The separate `xtask drift-check` compares event
names and field declarations, not validation and normalization behavior. Updating
its baseline does not make a semantic mismatch disappear.

In the monorepo migration, `../../interop` also runs these same fixtures against
the TypeScript source in the checkout. The pinned suite keeps the released SDK
contract visible; the local suite checks changes in the current PR.
