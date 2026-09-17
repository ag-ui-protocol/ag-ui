# Import provenance

The proposed `ag-ui` crate, drift tooling and selected deterministic E2E tests were
imported from [KimSoungRyoul/ag-ui-rust](https://github.com/KimSoungRyoul/ag-ui-rust)
at commit `43089f4cbf8566887daa5895f13728b4006f8321` (v0.4.2), under the MIT license.
The original copyright notice is retained in `crates/ag-ui/LICENSE` and
`LICENSE-ag-ui` for the imported tooling and tests.

The AG-UI changes from public [PR #11](https://github.com/KimSoungRyoul/ag-ui-rust/pull/11),
commit `515586d47162663ffbb55b58e7877536151fba25`, are also included. That PR was
merged publicly as `d228b0467a29f4e631b0f9b30628ab09d78765ed`; it is not a new
crate release. The semantic probe, 44-case interoperability suite and AG-UI-only
JSON ordering regression were brought over without the A2UI or website changes.

The existing community SDK by @wdoppenberg and contributions by others is retained
in `crates/ag-ui-core` and `crates/ag-ui-client`, unchanged from the upstream base.
The proposal follows the coordination in upstream #2256/#972 and the standalone
SDK's #10. It does not imply adoption, source removal, or package ownership changes.

The import excludes `ag-ui-a2ui`, model-provider test helpers, live model tests,
personal skills, website assets and publishing workflows. Integration changes
adapt the manifests and documentation to this workspace, add a local-source
protocol check, and verify the migration path without publishing any package.

The bounded HTTP error-body reader and three regression tests now match the
standalone SDK's [PR #12](https://github.com/KimSoungRyoul/ag-ui-rust/pull/12), commit
`638b4407722d432dcdeb38ee2f7b9740b650002a`. The cases cover an open-ended error body,
small HTTP errors and truncation across a UTF-8 boundary.

The combined lockfile updates vulnerable/yanked `bytes`, `h2`, `rustls`,
`rustls-webpki`, `slab` and `zerovec` dependencies within the existing manifest
constraints. Existing package source and public APIs are retained.
