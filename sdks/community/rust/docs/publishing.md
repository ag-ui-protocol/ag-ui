# Publishing `ag-ui` and `ag-ui-a2ui`

The proposed `.github/workflows/publish-rust.yml` is a manual workflow for the
official `ag-ui-protocol/ag-ui` repository. It publishes `ag-ui`, waits for registry
availability, then publishes the dependent `ag-ui-a2ui` crate at the same version;
the existing `ag-ui-core` and `ag-ui-client` packages keep their own release plans.

Configure a GitHub Trusted Publisher on crates.io for **each** crate with:

| Field | Value |
| --- | --- |
| Repository owner | `ag-ui-protocol` |
| Repository name | `ag-ui` |
| Workflow filename | `publish-rust.yml` |
| Environment name | Leave empty; this workflow does not name an environment |

The workflow must first be reviewed and merged upstream. Registering its identity
does not merge the proposal, choose maintainers or publish a crate version.

## Manual release

1. Prepare an agreed, unpublished version for both crates: update the workspace
   version and both internal dependency versions in `Cargo.toml`, refresh
   `Cargo.lock`, and merge the change.
2. Run **Publish Rust SDK** on `main`, enter that exact version, and keep
   `dry_run` enabled for verification. This does not request a publishing token.
3. To publish, run it on official `main` with the same version and `dry_run`
   disabled. Verification runs again before a short-lived crates.io token is
   requested. The upload uses the exact commit that passed verification.

The workflow requires both manifest versions to match the requested version. It
checks tests, Clippy, dependency advisories, local protocol drift, TypeScript
interoperability, official A2UI web-core interoperability, and both package builds.
Cargo packages the two crates together so `ag-ui-a2ui` is verified against the
candidate `ag-ui` even before that version is available on crates.io.
A real publish is rejected
from forks or other branches. Already published versions cannot be overwritten.
No version bump, Git tag or GitHub Release is created by this workflow.
