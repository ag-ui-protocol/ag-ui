# Changelog

## 0.0.6 — 2026-11-02

- Added `A2UIGenerationError`. Adapters can raise it from the sub-agent call with structured errors; `run_a2ui_generation_with_recovery` records the failed attempt and feeds those errors back to the model on the next attempt, within the existing attempt limit. Other exceptions (transport failures, cancellation) still propagate unchanged.
- Added an optional `inference_format` tool parameter (`"direct_json"` or `"express"`, default `"direct_json"`) for adapters that support A2UI Express. Existing callers are unaffected.

### Breaking changes

None.

## 0.0.5 — 2026-10-15

- Added a stable Changelog URL to the published package metadata, which now appears on PyPI.

### Breaking changes

None.
