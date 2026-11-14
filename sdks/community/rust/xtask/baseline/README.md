# AG-UI 1.0 schema baseline

`events.json` is generated from `spec/1.0/schema.json`. It records the normative
event union, field names and requiredness, and stable signatures for the schema
root and every `$defs` shape. Signatures exclude descriptive text, so a field
type, union or root constraint change demands review even when the event and
field names stay the same.

In the monorepo, CI runs:

    cargo run -p ag-ui-xtask -- drift-check --local

This compares the schema in the same checkout with the reviewed baseline, and
compares its event names, fields, requiredness and wire types with
`crates/ag-ui/src/event/`. The five retired
`THINKING_*` Rust variants are retained for older recordings and explicitly
excluded from the normative 1.0 union comparison. A missing local schema is a
check error, never a clean result.

Other modes:

    cargo run -p ag-ui-xtask -- drift-check              # offline baseline vs Rust
    cargo run -p ag-ui-xtask -- drift-check --upstream   # also check latest upstream schema
    cargo run -p ag-ui-xtask -- drift-check --refresh    # regenerate reviewed baseline

`--upstream` and `--refresh` need network access. An unavailable upstream
freshness check exits with a check error; it does not report success. After a
schema change, review the baseline diff and update the Rust implementation in
the same pull request.

The Rust source scanner classifies supported Rust field types by their JSON
wire kind and fails when a type cannot be classified. Schema signatures catch
deeper changes for review. This check does not prove full nested serialization
equivalence; wire round-trip and conformance tests cover that separately.
