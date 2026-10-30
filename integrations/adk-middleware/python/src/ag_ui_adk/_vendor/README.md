# Temporary A2UI Express streaming SDK snapshot

Source: [a2ui-project/a2ui PR #3712](https://github.com/a2ui-project/a2ui/pull/3712),
merged revision **f290f54b09d85509b5fa8e09b722b7282c776a65** (2026-10-29).
The snapshot contains only `python/a2ui_agent/src/a2ui` and
`python/a2ui_core/src/a2ui` from that revision, under the Apache 2.0 license in
`LICENSE.a2ui`. Upstream copyright and license headers are retained.

The newest published Agent SDK at implementation time is `0.9.0`, released
2026-10-17, before incremental Express streaming. The merged implementation
requires matching `a2ui-core>=0.4.1`; published core `0.4.0` does not provide the
same renderer-state internals. Both source trees are isolated here to avoid
mixing incompatible model/state types. The legacy Direct JSON path continues
using the released SDK. No A2A or ADK framework integrations are vendored.

Only Python module references beginning `a2ui.` are mechanically relocated to
`ag_ui_adk._vendor.a2ui.`. Schema URLs and non-Python resources are unchanged;
there are no custom parser, compiler, streaming or validation algorithms.
`manifest.json` records every original and relocated file SHA-256.

Regenerate from the pinned archive with `python3 scripts/vendor-a2ui-express.py`.
For an already extracted copy of that exact revision, use `--source PATH`.

> **Temporary vendoring — removal required once a compatible published SDK includes PR #3712.**

Removal tracking: upstream [#3712](https://github.com/a2ui-project/a2ui/pull/3712).
Remove this entire snapshot and its regeneration script when a released Agent
SDK includes that revision's `ExpressResponseStream`/`ExpressScopeSession` and
its compatible core release is available. Raise the released SDK dependency
floor, use its public imports, and rerun the adapter's streaming, recovery,
import-isolation and wheel-resource tests before removal. This is a temporary
compatibility dependency, not a fork intended for independent development.
