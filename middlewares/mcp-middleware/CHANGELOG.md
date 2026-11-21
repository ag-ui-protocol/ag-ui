# Changelog

## 0.0.2 — 2026-09-11

- Lists tools from MCP servers, injects them namespaced as `mcp__{server}__{tool}` (truncated to 64 chars, deduped), and executes tool calls server-side.
- Multi-iteration tool loops now present as a single run: RUN_STARTED suppressed on continuations, RUN_FINISHED flushed only when the loop stops.
- Forwards `serverConfig.headers` to both transports via `requestInit` for per-request auth; caches `listTools` results per instance.
- Syncs tool results into downstream `agent.messages` so subsequent iterations consume results instead of re-emitting the call.
- Buffers RUN_FINISHED until tool results are emitted to avoid post-RUN_FINISHED validation failures.
- Routes `onRunComplete` rejections to `subscriber.error` and guards `client.close()` so failures cannot hang the stream.
- SSE transport now imported lazily, avoiding an `eventsource` load-time failure under Bun.
- Logs tool-execution and per-server listing failures server-side.
- Added MIT LICENSE file and license field for published package.

### Breaking changes

- `@ag-ui/client` moved from dependencies to a peer dependency (>=0.0.40); consumers must install it themselves.
