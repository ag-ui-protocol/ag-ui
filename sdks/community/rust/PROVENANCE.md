# Import provenance

The feature-based `ag-ui` SDK originates in
[KimSoungRyoul/ag-ui-rust](https://github.com/KimSoungRyoul/ag-ui-rust).
The first import came from v0.4.2. The full runtime and protocol models for
the 1.0.0 release match standalone commit
`77061a66aba60e9d387aac77b65dcf2f87f7d03c`. The Git tree for
`crates/ag-ui/src` is `6b9813f4d4e0ea88571b8d57dcf7718236c9cb82` in both
workspaces. This update also synchronizes the AG-UI tests and deterministic
examples, with the checkout-specific adaptations below.
The MIT notice is included in `crates/ag-ui/LICENSE` and `LICENSE-ag-ui`.

Both copies embed the frozen AG-UI 1.0 schema. This checkout reads the official
fixtures and conformance streams from `spec/1.0/` directly. The Rust-only stream
cases live in `crates/ag-ui/tests/fixtures/local/`. Cargo exercises the tests
that read the monorepo’s fixtures in the workspace and omits those targets
from the registry archive. The monorepo also runs its
checkout-specific drift checker, TypeScript source interop suite and existing
community crate tests. A2UI, live model tests, the standalone website and the
standalone release workflow have separate ownership.

The existing `ag-ui-core` and `ag-ui-client` packages carry the work of
@wdoppenberg and other contributors. Their separate
[1.0 parity proposal](https://github.com/ag-ui-protocol/ag-ui/pull/3214) and the
[Rust code owners proposal](https://github.com/ag-ui-protocol/ag-ui/pull/2367)
remain under upstream review.
