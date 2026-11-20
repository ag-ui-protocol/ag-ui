# Official A2UI web core interoperability

This suite feeds Rust-generated A2UI v0.9.1 messages directly into
`@a2ui/web_core@0.11.0`. Run from `sdks/community/rust` with Node.js 22.12 or newer:

```sh
npm ci --ignore-scripts --prefix e2e/a2ui-interop
npm test --prefix e2e/a2ui-interop
```

The test runs the `a2ui_wire` example in `ag-ui-migration-tests`. It creates and
edits a surface with `A2uiAuthor`, extracts the operations emitted by
`RunContext::send_a2ui`, and compares the Rust `SurfaceStore` with the official
`MessageProcessor` after each step. No model, server or credentials are needed.

The 13 steps cover creation, editing, explicit null, missing and null parents,
sparse and nested arrays, object/array deletion, component replacement, and
surface deletion/recreation. JavaScript does not rewrite the wire messages.
The comparison preserves undefined values and sparse slots in model snapshots.
This checks schema and state processing, not browser widget layout or input.
