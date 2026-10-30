# Proposed transition and release responsibilities

This checklist translates the discussion in
[KimSoungRyoul/ag-ui-rust#10](https://github.com/KimSoungRyoul/ag-ui-rust/issues/10)
into review tasks. It is a proposal, not a grant of ownership or an upstream
adoption decision. The upstream team makes that decision in
[ag-ui-protocol/ag-ui#2256](https://github.com/ag-ui-protocol/ag-ui/issues/2256).

## Implementation ready for review

- A single `ag-ui` crate provides protocol types and feature-selected server,
  client and Axum APIs. No core/client/server package split is needed.
- Existing source, patch overrides and package CI are retained during review.
  The proposed `ag-ui` crate is independent of the two existing packages.
- Local-source drift, representative event round trips and pinned semantic
  boundary cases cover different contracts; all remain part of the proposal.
- Public SDK PR #11 is included. A2UI and private consumer policies are excluded.

## Agreements required before adoption and publishing

| Topic | Proposed next step | Decision or consent needed |
| --- | --- | --- |
| Branch review | Mike offered to review the branch before a draft PR | Coordinate review timing; no approval is assumed |
| Final legacy releases | Keep the current API/behavior, add migration links, then mark the old packages as no longer maintained | @wdoppenberg and the agreed maintainers |
| Existing source removal | Consider a separate follow-up after agreeing on adoption and migration | Upstream team and existing maintainers |
| `ag-ui` ownership | Organization team plus at least two individual maintainers, as proposed in #10 | Upstream team and current crate owner; everyone must accept |
| CODEOWNERS | Align review responsibility with the maintainers actually taking on the SDK | Upstream team; this branch changes no CODEOWNERS |
| Publishing | Review the manual `publish-rust.yml`, then agree on the next version and release sign-off | Agreed maintainers; publishing is restricted to official `main` |
| Official documentation | Mike offered to rewrite the Rust pages after a draft PR exists | Coordinate that work with the final API and migration plan |
| Existing PRs | Map resolved requirements and retain still-useful client verifier/middleware work | Original contributors and upstream reviewers |
| Captured fixtures | Mike offered 34 captured event JSON fixtures as a follow-up PR | Contributor review after the layout settles |

Any final legacy releases should be prepared from their existing implementation,
not by re-exporting `ag-ui` under the old names: the Rust APIs are incompatible.
Do not yank old versions solely to redirect users. This branch keeps both existing
packages available for comparison and changes no installed crates.io package.

The proposed [publishing workflow](publishing.md) defaults to verification only.
It does not publish on a push or release event, and no package is uploaded as
part of preparing this branch.

The existing server `EventVerifier` is now public, but that does not decide whether
a client-specific verifier or middleware is useful. Review those requirements
against the current client before re-porting code. Likewise, the captured fixtures
would complement the synthetic boundary tests; they are not claimed as included.

## Proposed versioning policy

The team should confirm this policy before the first upstream release:

- `Event` and `EventType` are exhaustive public enums. Adding an event variant can
  break downstream matches and requires a compatibility-breaking version change.
- For `0.y.z` releases, use the next minor series (`0.y.z` to `0.(y+1).0`) for that
  boundary. From `1.0.0` onward, use the next major version. This follows
  [Cargo's SemVer conventions](https://doc.rust-lang.org/cargo/reference/semver.html).
- Review required fields, decoding acceptance, serialization defaults and public
  APIs separately; an unchanged event count does not establish compatibility.
- Document corrections such as explicit-null rejection and consumer-owned map
  ordering in release notes, and agree on their version impact before publishing.

The imported source was `0.4.2`, which is already published by the standalone
project. This branch uses `0.5.0` as an unpublished candidate so package checks
and documentation cannot mistake the candidate for that release. The upstream
maintainers must agree on the first version before publishing; preparing this
branch creates no release tag or registry publication.
