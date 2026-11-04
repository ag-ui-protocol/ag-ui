# Changelog

## 0.0.3 — 2026-10-12

- Updated framework adapter to the 1.0 data models, following part renames, flattening tool result content to text where the provider requires it, and naming dropped parts by wire type.
- File sources that would send a provider handle are now dropped with a warning.
- Added MIT LICENSE file and `license` field to the published package.

### Breaking changes

- Requires `@ag-ui/core` and `@ag-ui/client` >=1.0.0 as peer dependencies.
- Part renames and tool result content flattening change wire output; re-verify against providers.
- Unsupported file sources are now dropped instead of forwarded.
