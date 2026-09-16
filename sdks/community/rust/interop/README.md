# Rust / TypeScript event interoperability

From this directory, run `npm ci --ignore-scripts` and `npm test`.
The harness bundles the actual TypeScript schemas in this checkout, validates
one fixture for every current event variant, sends the normalized JSON through
the Rust event types, then validates and compares the result with TypeScript.

`events.json` originates from the imported `upstream_payloads.rs` fixtures. It is
not generated from the Rust serializer. A new event requires a reviewed fixture.
This checks representative wire payloads, not every field value or streaming
behavior. Rust's HTTP tests cover streaming and cancellation separately.

The same 44 semantic boundary fixtures used by `e2e/interop` are also checked
against the local TypeScript schemas, including rejection and normalization.
Both suites share assertions and explicitly pin the two typed representation
differences. This catches semantic changes in a TypeScript-only PR that a
published-package comparison could not see.
