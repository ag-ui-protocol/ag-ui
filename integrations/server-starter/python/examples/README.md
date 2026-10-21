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
in server history mode (`historyMode: "server"` or `"auto"` in
`@ag-ui/client`, a prototype not yet in a release) uploads only the messages
the server has not confirmed yet and points at the latest confirmed one with
`forwardedProps["ag-ui:historyCursor"]`. Clients without that mode send their
full history without a cursor, which the endpoint also accepts.

- A cursor the server cannot find (unknown thread or unknown id) yields
  `RUN_ERROR` with code `HISTORY_UNAVAILABLE` right after `RUN_STARTED`, and a
  supporting client retries once with its full history and no cursor.
- Client input is untrusted: stored ids are never overwritten (a resent
  message, including the owning assistant message sent next to a tool
  result, is ignored), only `user` messages and the first `tool` result for
  each pending tool call are stored, and other `assistant` messages and
  orphan `tool` results are dropped. Tool results are stored before user
  messages so a result keeps following its tool call. Stored copies drop
  `encryptedValue`, `subagentRunId` and unknown fields.
- `system` and `developer` messages are read on every run and used for that
  run only. They are never stored and never appear in a snapshot.
- The model context is built from the store. Each run ends with a
  `MESSAGES_SNAPSHOT` of the stored thread (including the new reply) before
  `RUN_FINISHED`, so a lagging client catches up and every id in it is a
  valid cursor.
- Runs on the same thread are serialized, and a run's messages are stored only
  after `RUN_FINISHED` was sent, matching when the client confirms them.
- The reply (`Turn N: U user messages, T tool results in server context;
  instructions: I.`) counts stored user messages and tool results plus this
  request's instructions, which makes it easy to check where the context came
  from.

Requests without a cursor follow two policies:

- **Unknown thread (fresh start).** Only `user` messages are kept. Resent
  `assistant` turns are client claims and resent `tool` results have no stored
  call to answer, so the server starts a fresh thread from the user's own
  words instead of importing history it cannot verify. This is what the
  full-history retry after `HISTORY_UNAVAILABLE` gets.
- **Known thread (divergence resend).** A client whose confirmed history
  changed (edit, rewind, regenerate) resends its full history without a
  cursor. Ids the server already holds are ignored, so the stored thread wins,
  and new `user` messages are appended.

Frontend tool round trip: if the client declares a tool named `confirm` and
its newest user message contains the word "confirm", the reply also calls
`confirm`. The call stays pending in the store, and a later run accepts the
client's `tool` result for it. Once a user message was stored after the call,
the call is abandoned and a late result is dropped, so a result never lands
after later user turns.

See `example_server/server_history.py`.

## Tests

```bash
uv run pytest
```

The cross-component test drives a real `@ag-ui/client` agent against this
server (it starts the server itself with `uv`):

```bash
pnpm install
pnpm --filter @ag-ui/client build
pnpm --filter @ag-ui/server-starter test:e2e
```

Set `SERVER_HISTORY_E2E_URL=http://localhost:8000/server-history` to run it
against a server you started yourself.
