# Changelog

## 0.2.0 — 2026-10-05

- Added `max_tool_calls_per_turn` to bound the number of tool calls (custom, frontend, and built-in) within a single turn, enforced via a pre-tool-call decide hook.
- Prevents turns from running tool cycles indefinitely after a client disconnects.
- Off by default; existing behavior is unchanged unless the limit is set.

### Breaking changes

None.
