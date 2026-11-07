# Rust / TypeScript event interoperability

From this directory, run `npm ci --ignore-scripts` and `npm test`.
The harness bundles the actual TypeScript schemas in this checkout, validates
one fixture for each of the 31 normative AG-UI 1.0 event variants, sends the
normalized JSON through Rust, then compares it with TypeScript. Five retired
`THINKING_*` fixtures are checked separately against Rust's low-level codec;
the client compatibility boundary translates historical streams before
application delivery.

`events.json` originates from the imported `upstream_payloads.rs` fixtures. It is
not generated from the Rust serializer. A new event requires a reviewed fixture.
This checks representative wire payloads, not every field value or streaming
behavior. Rust's HTTP tests cover streaming and cancellation separately.

The 44 historical semantic boundary cases run separately against the pinned
`@ag-ui/core@0.0.59` in `e2e/interop`. The current 1.0 generated Zod schemas
are intentionally loose parse models: unknown fields can survive their parse
step and are removed later by the client enforcement stage. Comparing the old
cases directly to those parse models would confuse parsing with full client
semantics. The Rust client runs normative 1.0 stream fixtures from the shared
conformance corpus in its own tests.
