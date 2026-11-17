# Changelog

## 0.0.4 — 2026-10-13

- Requires AG-UI 1.0 (`@ag-ui/core` / `@ag-ui/client` `>=1.0.0`).
- Caps the protocol at 0.0.39 through `maxProtocolVersion` (was the deprecated `maxVersion`), because the community Java SDK is not on 1.0 yet. The client flattens message content to text before sending; images, audio, video and documents are dropped with a console warning.
- The README now documents Spring AI (it had been copied from LlamaIndex).

### Breaking changes

None.

## 0.0.3

- Publish the declared Apache-2.0 license and license file in the npm package.
