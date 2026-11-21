# Changelog

## 0.0.60 — 2026-11-21

- Added ADK-JS 2.x integration scaffolding option.
- Updated templates to target the 1.0 client with generated models and the enforcement pipeline.
- Scaffolded projects now build on `@ag-ui/core` generated types with a zod-free main entry; validators live at `@ag-ui/core/schemas`.
- 0.x type names remain available as deprecated aliases (see DEPRECATIONS.md).

### Breaking changes

- Generated projects now use 1.0 package APIs; zod becomes an optional peer and 0.x names are deprecated aliases.
- Re-verify generated apps against the new protobuf wire and enforcement pipeline.

## 0.0.59

- Publish the declared MIT license and license file in the npm package.
