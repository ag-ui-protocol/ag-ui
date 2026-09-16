# Import provenance

The proposed `ag-ui` crate, drift tooling and selected deterministic E2E tests were
imported from [KimSoungRyoul/ag-ui-rust](https://github.com/KimSoungRyoul/ag-ui-rust)
at commit `43089f4cbf8566887daa5895f13728b4006f8321` (v0.4.2), under the MIT license.
The original copyright notice is retained in `crates/ag-ui/LICENSE` and
`LICENSE-ag-ui` for the imported tooling and tests.

The existing community SDK by @wdoppenberg and contributions by others remain
unchanged in `crates/ag-ui-core` and `crates/ag-ui-client`. This proposal follows
the coordination in issues #2256 and PR #972; it does not imply approval by those
contributors or by the AG-UI team.

The import excludes `ag-ui-a2ui`, model-provider test helpers, live model tests,
personal skills, website assets and publishing workflows. Integration changes
adapt the manifests and documentation to this workspace, add a local-source
protocol check, and verify the migration path without publishing any package.

One transport fix bounds HTTP error-body reads before buffering, with a regression
test using a response that stays open. The original implementation truncated the
displayed error only after reading the entire body.

The combined lockfile updates vulnerable/yanked `bytes`, `h2`, `rustls`,
`rustls-webpki`, `slab` and `zerovec` dependencies within the existing manifest
constraints. The legacy package source remains unchanged.
