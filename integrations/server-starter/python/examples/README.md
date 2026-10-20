# Server Starter

This starter kit demonstrates sending the minimal set of events that are needed to stream data from the agent to the frontend.

## Running the server

To run the server:

```bash
cd integrations/server-starter/python/examples

uv sync && uv run dev
```

## Endpoints

| Route | What it shows |
| --- | --- |
| `POST /` | Hello world: streams a single assistant message. |
| `GET /capabilities` | Capability discovery for `/` (declares nothing extra). |
| `POST /server-history` | Server-managed history (prototype for [#2186](https://github.com/ag-ui-protocol/ag-ui/issues/2186)), see below. |
| `GET /server-history/capabilities` | Advertises `custom.serverManagedHistory: true`. |

### Server-managed history

`/server-history` keeps each thread's messages in an in-memory store. A client
that supports server-managed history (the client side is a separate
prototype, not yet in the released SDKs) only uploads messages the server has
not confirmed yet and points at the last confirmed one with
`forwardedProps["ag-ui:historyCursor"]`. Today's clients send their full
history without a cursor, which the endpoint also accepts.

- An unknown thread or cursor yields `RUN_ERROR` with code
  `HISTORY_UNAVAILABLE`, and a supporting client retries once with its full
  history.
- Runs on the same thread are serialized, and a run's messages are stored only
  after `RUN_FINISHED` was sent, matching when the client confirms them.
- Client input is untrusted: stored messages are never overwritten, only
  `user` messages and `tool` results for pending tool calls are accepted, and
  `assistant`, `system`, `developer` and orphan `tool` messages are dropped.
- The reply (`Turn N, M user messages in server context.`) is computed from
  the server store, which makes it easy to check where the context came from.

See `example_server/server_history.py`.

## Tests

```bash
uv run pytest
```
