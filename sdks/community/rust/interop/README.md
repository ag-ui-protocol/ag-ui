# Rust / TypeScript event interoperability

From this directory, run `npm ci --ignore-scripts` and `npm test`.
The harness bundles the actual TypeScript schemas in this checkout, validates
one fixture for every current event variant, sends the normalized JSON through
the Rust event types, then validates and compares the result with TypeScript.

`events.json` originates from the imported `upstream_payloads.rs` fixtures. It is
not generated from the Rust serializer. A new event requires a reviewed fixture.
This checks representative wire payloads, not every field value or streaming
behavior. Rust's HTTP tests cover streaming and cancellation separately.
