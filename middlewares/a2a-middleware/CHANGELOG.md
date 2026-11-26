# Changelog

## 0.0.6 — 2026-10-13

- Delegation logging now respects the debug setting; A2A tasks and replies are only logged with `console.debug` when `debug.enabled` is true, instead of always.

### Breaking changes

None.

## 0.0.5 — 2026-10-13

- Works through runtimes that clone the agent per request, such as CopilotKit: `clone()` now carries over the agent cards, clients, instructions and orchestrator. Before, a clone's first run threw while reading the agent cards.
- A delegated `send_message_to_a2a_agent` call no longer fails with "Tool arguments not found": its arguments are read from the run's own stream, which also stops the orchestrator from being subscribed to twice.

### Breaking changes

None.

## 0.0.4 — 2026-10-12

- Requires `@ag-ui/client` `>=1.0.0`; the unused `@ag-ui/core` peer is gone.
- Drops an unused `@ag-ui/core/schemas` import, so the package no longer imports anything from `@ag-ui/core`.

### Breaking changes

None.

## 0.0.3

- Publish the declared MIT license and license file in the npm package.
