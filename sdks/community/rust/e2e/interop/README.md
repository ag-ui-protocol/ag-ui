# AG-UI schema semantics

This suite feeds the same boundary cases to `@ag-ui/core@0.0.59` and the Rust
SDK. npm pins the official SDK and Zod with an integrity-checked lockfile. The
Rust probe uses ordinary typed decoding and `RunOutcome::validate()` for its
non-empty interrupt rule. It never substitutes an SDK parser with a test parser.

```sh
npm ci --prefix e2e/interop --ignore-scripts
npm test --prefix e2e/interop
```

The cases cover empty, absent, null and incorrectly typed deltas; default roles;
metadata and attribution; nullable tool parents and run outcomes; token usage;
strict outcome fields; and run input. Acceptance must agree with the official
schema. Accepted values must normalize identically, except for this explicit
Rust representation contract, with both outputs pinned in `cases.json`:

- Typed `Event` decoding ignores unknown top-level fields; TypeScript's base
  schema preserves them. Retain the raw JSON when forwarding unknown extensions,
  or use the protocol's `metadata` field. Typed decoding is not a lossless proxy.

Absent input `state` and `forwardedProps` are omitted on serialization. The
1.0 request schema rejects explicit null for either field; this pinned older
schema suite uses non-null input values when the field is present.
`role` defaults only when absent, and outcome objects reject unknown fields.

These are targeted semantic checks, not a claim that every possible protocol
value has been proven equivalent. The separate `xtask drift-check` compares event
names and field declarations, not validation and normalization behavior. Updating
its baseline does not make a semantic mismatch disappear.

In the monorepo migration, `../../interop` also runs these same fixtures against
the TypeScript source in the checkout. The pinned suite keeps the released SDK
contract visible; the local suite checks changes in the current PR.
