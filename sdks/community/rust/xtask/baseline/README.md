# Upstream baseline

In the monorepo, CI uses `cargo run -p ag-ui-xtask -- drift-check --local`.
It reads the TypeScript source in the same checkout, so changes in a PR are
checked before merge. The snapshot below remains useful for offline comparison
of the imported standalone revision; it is not the monorepo source of truth.

`events.json` is a vendored snapshot of the AG-UI event surface as declared by
the protocol's source of truth:

    ag-ui-protocol/ag-ui : sdks/typescript/packages/core/src/events.ts

It records the upstream commit it was taken from, the date it was taken, the
`EventType` values in upstream order, and each event's payload fields with an
optional/required flag as extracted from the Zod schema.

## It is generated, not written

    cargo run -p ag-ui-xtask -- drift-check --refresh

Never hand-edit it. Editing this file by hand is editing the protocol to match
the code, which is precisely the failure this check exists to catch: the
previous community Rust SDK drifted ten event types behind the spec because
nothing mechanically linked the two.

## How it is used

    cargo run -p ag-ui-xtask -- drift-check              # offline, deterministic — the CI gate
    cargo run -p ag-ui-xtask -- drift-check --upstream   # is this snapshot itself stale? (network)
    cargo run -p ag-ui-xtask -- drift-check --refresh    # re-capture it (network)

The offline check compares this file against `crates/ag-ui/src/event/`,
read as text so it keeps working while that module does not compile. It exits
non-zero when an event type or a payload field differs. CI depends on that run
only — the network-using modes are for a scheduled job and for a human.

## Accepting an upstream change

When `--upstream` reports that upstream has moved:

1. Run `--refresh`.
2. Read the diff to this file. That diff *is* the protocol change — it is the
   part of the pull request that deserves the closest review.
3. Update `crates/ag-ui/src/event/` to match, in the same pull request.
4. Re-run `drift-check` until it is clean.

## `unparsed`

An event carrying an `unparsed` field is one whose Zod schema the extractor
could not read confidently, so its fields are not compared and `drift-check`
reports a warning rather than a failure. The event type itself is still
compared. If that list grows, teach `xtask/src/drift/upstream.rs` the shape
rather than lowering the check — but a check that cries wolf gets disabled,
which is why an unreadable schema is never a hard failure.
