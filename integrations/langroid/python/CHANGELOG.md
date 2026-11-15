# Changelog

## 0.2.0 — 2026-10-12

- Requires AG-UI 1.0 (`ag-ui-protocol>=1.0.0`). `RUN_STARTED` declares `protocol_version`.
- User messages with content-part arrays are read correctly instead of becoming the prompt "Hello"; dropped media is logged.
- The endpoint helper takes an `origins` argument and forwards FastAPI route kwargs (`name`, `tags`, `dependencies`, …).
- The health route is `/health` (was `//health`) when mounted at the root path.

### Breaking changes

- CORS credentials are no longer enabled for the default wildcard origin. If browsers call the agent with cookies or other credentials from another origin, pass those origins explicitly via `origins`.
