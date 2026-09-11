# Changelog

## 0.1.0 — 2026-09-10

- Forward auth headers to HTTP and SSE transports; strip credentials from public server hashes and prevent forwarding through redirects.
- Load the SSE transport lazily so `eventsource` is not pulled into the module graph for HTTP-only configs (fixes fatal error under Bun).
- Honor tool visibility, retain diagnostics, and read current nested UI metadata.
- Release sessions after failed handshakes and bound HTTP session cleanup; preserve proxy results when cleanup fails.
- Reject blocked proxy methods before opening sessions and keep upstream errors private.
- Add MIT LICENSE file and license field for published package.

### Breaking changes

- Requires `@modelcontextprotocol/sdk` 1.15.0 for guarded fetch and session cleanup.
- Public server hashes now exclude credentials, changing computed hash values.
- Blocked proxy methods are rejected before session creation; stricter discovery and origin guard behavior.
