# Rust SDK coordination

[PR #2778](https://github.com/ag-ui-protocol/ag-ui/pull/2778) adds the feature-based
`ag-ui` crate. It targets the frozen 1.0 protocol and uses the same runtime source
as the standalone SDK. This workspace also tests the existing `ag-ui-core` and
`ag-ui-client` crates.

| Decision | Where it is being discussed |
| --- | --- |
| Adoption of the feature-based crate and its relationship to the existing packages | [#2256](https://github.com/ag-ui-protocol/ag-ui/issues/2256), [standalone coordination issue](https://github.com/KimSoungRyoul/ag-ui-rust/issues/10) |
| AG-UI 1.0 parity in the existing community crates | [#3214](https://github.com/ag-ui-protocol/ag-ui/pull/3214) |
| Rust SDK review ownership | [#2367](https://github.com/ag-ui-protocol/ag-ui/pull/2367) |
| Future `ag-ui` registry publication from this monorepo | The current crate owner and upstream maintainers must agree on access, release sign-off and the [publishing workflow](publishing.md). |

The initial feature-based release targets AG-UI 1.0 with crate version `1.0.0`.
The SDK follows Cargo SemVer. Compatible fixes increment the patch version,
compatible features increment the minor version and breaking Rust API changes
increment the major version. For example, adding a variant to an exhaustive public
enum such as `Event` can require a major release. The wire declaration identifies
the protocol version independently of the crate version.
