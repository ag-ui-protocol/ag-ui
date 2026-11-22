# Import provenance

The feature-based `ag-ui` SDK originates in
[KimSoungRyoul/ag-ui-rust](https://github.com/KimSoungRyoul/ag-ui-rust).
The first import came from v0.4.2. The runtime in this checkout matches the
[ag-ui 1.0.0 package on crates.io](https://crates.io/crates/ag-ui/1.0.0).
The [v1.0.0 tag](https://github.com/KimSoungRyoul/ag-ui-rust/releases/tag/v1.0.0)
identifies commit `071aeada5add7921f44af58c79e774f1f233a138`. Both workspaces
have the same `crates/ag-ui/src` tree, `b8c22dad96dd60cc4743c0d564494faf8711bff7`.
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
