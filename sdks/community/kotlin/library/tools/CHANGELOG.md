# Changelog

## 0.5.0 — 2026-11-05

- Added wasmJs (browser) and macosArm64 targets.
- CircuitBreaker now accepts an injected kotlinx.datetime Clock; the existing single-argument constructor remains and defaults to Clock.System.

### Breaking changes

- Group ID changed to com.ag-ui.community; com.contextable references removed.
- minSdk lowered to 24; Kotlin pinned to 2.1.20.
