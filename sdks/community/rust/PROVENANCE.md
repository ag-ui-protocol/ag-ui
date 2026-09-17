# Import provenance

The proposed `ag-ui` crate, drift tooling and selected deterministic E2E tests were
imported from [KimSoungRyoul/ag-ui-rust](https://github.com/KimSoungRyoul/ag-ui-rust)
at commit `43089f4cbf8566887daa5895f13728b4006f8321` (v0.4.2), under the MIT license.
The original copyright notice is retained in `crates/ag-ui/LICENSE` and
`LICENSE-ag-ui` for the imported tooling and tests.

The AG-UI changes from public [PR #11](https://github.com/KimSoungRyoul/ag-ui-rust/pull/11),
commit `515586d47162663ffbb55b58e7877536151fba25`, are also included. That PR was
merged publicly as `d228b0467a29f4e631b0f9b30628ab09d78765ed`; it is not a new
crate release. The semantic probe, 44-case interoperability suite and JSON
ordering regression are included.

The companion `ag-ui-a2ui` crate, A2UI HTTP/SSE tests, and official web-core
interoperability checks are imported from the public source at commit
`3f623aaa48c4112163c21f5a0c20be8585304dfd`. The web-core fixture exporter is adapted
from the standalone Review Desk example into an unpublished Cargo example.
The crate's MIT license and vendored Apache-2.0 schema/fixture notices are retained.
See its [schema provenance](crates/ag-ui-a2ui/schemas/README.md) and
[conformance notes](crates/ag-ui-a2ui/tests/conformance/README.md) for upstream pins
and the cases outside the supported profile.

The existing community SDK by @wdoppenberg and contributions by others is retained
in `crates/ag-ui-core` and `crates/ag-ui-client`, unchanged from the upstream base.
The proposal follows the coordination in upstream #2256/#972 and the standalone
SDK's #10. It does not imply adoption, source removal, or package ownership changes.

The import excludes model-provider test helpers, live model tests,
personal skills, website assets and the standalone publishing workflows. Integration changes
adapt the manifests and documentation to this workspace, add a local-source
protocol check, and verify the migration path without publishing any package.

A monorepo-specific `publish-rust.yml` is proposed separately. It defaults to a
manual dry run; its publishing job is restricted to `ag-ui-protocol/ag-ui` main
and uploads `ag-ui` followed by `ag-ui-a2ui`.

The bounded HTTP error-body reader and three regression tests now match the
standalone SDK's [PR #12](https://github.com/KimSoungRyoul/ag-ui-rust/pull/12), commit
`638b4407722d432dcdeb38ee2f7b9740b650002a`. The cases cover an open-ended error body,
small HTTP errors and truncation across a UTF-8 boundary.

The combined lockfile updates vulnerable/yanked `bytes`, `h2`, `rustls`,
`rustls-webpki`, `slab` and `zerovec` dependencies within the existing manifest
constraints. Existing package source and public APIs are retained.
