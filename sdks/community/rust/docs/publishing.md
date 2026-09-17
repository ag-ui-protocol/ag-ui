# Publishing `ag-ui`

The proposed `.github/workflows/publish-rust.yml` is a manual workflow for the
official `ag-ui-protocol/ag-ui` repository. It publishes only the `ag-ui` crate;
the existing `ag-ui-core` and `ag-ui-client` packages keep their own release plans.

Configure the `ag-ui` crate's GitHub Trusted Publisher on crates.io with:

| Field | Value |
| --- | --- |
| Repository owner | `ag-ui-protocol` |
| Repository name | `ag-ui` |
| Workflow filename | `publish-rust.yml` |
| Environment name | Leave empty; this workflow does not name an environment |

The workflow must first be reviewed and merged upstream. Registering its identity
does not merge the proposal, choose maintainers or publish a crate version.

## Manual release

1. Prepare an agreed, unpublished `ag-ui` version in the manifest and merge it.
2. Run **Publish Rust SDK** on `main`, enter that exact version, and keep
   `dry_run` enabled for verification. This does not request a publishing token.
3. To publish, run it on official `main` with the same version and `dry_run`
   disabled. Verification runs again before a short-lived crates.io token is
   requested. The upload uses the exact commit that passed verification.

The workflow checks tests, Clippy, dependency advisories, local protocol drift,
TypeScript interoperability and the package build. A real publish is rejected
from forks or other branches. Already published versions cannot be overwritten.
No version bump, Git tag or GitHub Release is created by this workflow.
