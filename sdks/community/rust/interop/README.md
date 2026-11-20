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

The 44 semantic boundary cases run separately against the official
`@ag-ui/core@1.0.4` in [e2e/interop](../e2e/interop/README.md). Each documented
difference pins the result on both sides. The Rust client also runs the checkout's
AG-UI 1.0 conformance stream corpus and schema fixtures.

The same command runs the published TypeScript HttpAgent 1.0.5 against the Rust
Axum endpoint on a loopback socket. It checks both run IDs, the server's protocol
declaration, reconstructed assistant text, and history sent on the second turn.
