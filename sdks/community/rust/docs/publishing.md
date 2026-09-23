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
| Environment name | `rust-crates-publish` |

The workflow must first be reviewed and merged upstream. Registering its identity
does not merge the proposal, choose maintainers or publish a crate version.
Before a real publish, the upstream maintainers must configure the
`rust-crates-publish` GitHub Environment with required reviewers and register the
same environment name in the crates.io Trusted Publisher. Only the publishing job
uses this environment; dry-run verification needs no release approval.

## Manual release

1. Review and agree on the proposed `0.5.0` candidate version, or choose another
   unpublished version, then update the manifest, internal dependency and lockfile
   together before merge. The imported `0.4.2` is already published by the
   standalone project and cannot be reused.
2. Run **Publish Rust SDK** on `main`, enter that exact version, and keep
   `dry_run` enabled for verification. This does not request a publishing token.
3. To publish, run it on official `main` with the same version and `dry_run`
   disabled. Verification runs again; the configured environment reviewers must
   approve the publishing job before it requests a short-lived crates.io token.
   The upload uses the exact commit that passed verification.

The workflow checks tests, Clippy, dependency advisories, local protocol drift,
TypeScript interoperability and the package build. A real publish is rejected
from forks or other branches. Already published versions cannot be overwritten.
No version bump, Git tag or GitHub Release is created by this workflow.
