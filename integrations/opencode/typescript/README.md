# OpenCode AG-UI bridge

Connect an AG-UI client to an existing OpenCode server. The package provides an ESM HTTP client (`@ag-ui/opencode`) and server-side translation (`@ag-ui/opencode/server`). The Dojo demonstrates agentic chat and native human-in-the-loop interrupts for OpenCode permissions and questions.

## Versions

| Component                   | Version                         |
| --------------------------- | ------------------------------- |
| Node                        | 22 (repository `.node-version`) |
| pnpm                        | 10.33.4                         |
| AG-UI core, client, encoder | workspace 1.0.0                 |
| `@opencode-ai/sdk`          | exactly 1.18.32                 |
| OpenCode server             | 1.18.32                         |

The adapter uses the SDK's `/v2` JavaScript exports with its stable `/session`, `/event`, `/permission`, and `/question` HTTP endpoints. It does not use the experimental `/api/session` protocol. `session.promptAsync()` exists in this pinned SDK: no custom authenticated HTTP fallback is necessary. OpenCode's `/doc` reports API schema version `1.0.0`, which is distinct from the executable version.

## Run locally

From the repository root, use Node 22 and the pinned pnpm:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec nx run @ag-ui/opencode:build
```

Install OpenCode 1.18.32 separately, configure a model using its [provider setup](https://opencode.ai/docs/providers/), and start it in a disposable project:

```sh
cd /path/to/disposable-project
OPENCODE_SERVER_PASSWORD=local-server-password opencode serve --hostname 127.0.0.1 --port 4096
```

Start the bridge from this repository, using your own tokens:

```sh
OPENCODE_URL=http://127.0.0.1:4096 \
OPENCODE_DIRECTORY=/path/to/disposable-project \
OPENCODE_SERVER_PASSWORD=local-server-password \
AG_UI_TOKEN=local-bridge-token \
pnpm exec nx run @ag-ui/opencode:serve-example
```

The example fails clearly when `AG_UI_TOKEN` or `OPENCODE_URL` is missing. OpenCode owns model credentials; provider failures terminate the AG-UI run with a redacted error. The bridge never silently substitutes a fixture for a missing model.

| Environment variable       | Purpose / default                                                       |
| -------------------------- | ----------------------------------------------------------------------- |
| `HOST` / `PORT`            | HTTP bind address / port; `0.0.0.0` / `8027`                            |
| `AG_UI_TOKEN`              | Required bearer token for the single-user example                       |
| `OPENCODE_URL`             | Existing OpenCode server URL                                            |
| `OPENCODE_DIRECTORY`       | Trusted project directory; defaults to the example working directory    |
| `OPENCODE_SERVER_PASSWORD` | Optional OpenCode Basic auth password (username `opencode`)             |
| `OPENCODE_MODEL`           | Optional `providerID/modelID`; otherwise server default                 |
| `OPENCODE_SESSION_STORE`   | Durable store path; `.opencode-ag-ui-sessions` in the working directory |
| `OPENCODE_FIXTURE`         | `1` explicitly selects the local credential-free HTTP fixture           |
| `OPENCODE_URL_FOR_DOJO`    | Bridge URL used by Dojo; `http://localhost:8027`                        |
| `OPENCODE_AG_UI_TOKEN`     | Bearer token used by Dojo to reach the real bridge                      |

`GET /health` checks the bridge process. `POST /agentic_chat` accepts `RunAgentInput` and returns encoded SSE. Health does not attest to model availability. Request bodies are limited to 1 MiB; excessively buffered SSE clients are cancelled.

## Minimal client

```ts
import { HttpAgent } from "@ag-ui/client";
// OpenCodeAgent from @ag-ui/opencode is an equivalent convenience wrapper.
const agent = new HttpAgent({
  url: "http://localhost:8027/agentic_chat",
  headers: { Authorization: "Bearer local-bridge-token" },
  threadId: "conversation-1",
});
agent.addMessage({
  id: "user-1",
  role: "user",
  content: "Explain this project",
});
await agent.runAgent();
agent.addMessage({
  id: "user-2",
  role: "user",
  content: "What should I inspect next?",
});
await agent.runAgent();
```

Keep credentials on your application server; the single-user example token is not a production browser authentication design.

## Embed the server bridge

```ts
import { createServer } from "node:http";
import {
  OpenCodeBridge,
  FileSessionStore,
  createSdkTransport,
  createRequestHandler,
} from "@ag-ui/opencode/server";

const directory = "/authorized/project";
const bridge = new OpenCodeBridge({
  directory,
  transport: createSdkTransport({
    baseUrl: "http://127.0.0.1:4096",
    directory,
  }),
  store: new FileSessionStore("/private/bridge-sessions"),
});
const handler = createRequestHandler({
  bridge,
  directory,
  authenticate: async (request) => {
    // Replace with your verified identity provider, returning a stable
    // tenant + user identity. Never trust an owner supplied in the body.
    return request.headers.authorization === "Bearer example"
      ? "tenant/user"
      : undefined;
  },
});
createServer((req, res) => {
  void handler(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(8027, "127.0.0.1");
```

## Ownership, persistence, and failure semantics

- Session keys hash the authenticated owner, AG-UI thread, and normalized trusted directory. Arbitrary thread IDs are never interpreted as OpenCode session IDs. Each bridge instance is bound to one directory.
- `FileSessionStore` writes private files with atomic rename and exclusive per-thread directory locks. Multiple bridge processes on **one host and one shared local store** reject concurrent turns. For multiple hosts, implement `SessionStore` with transactional storage and distributed locking. Do not use separate stores for the same sessions.
- OpenCode sessions created by the bridge must be exclusively controlled by the bridge. OpenCode abort is session-scoped, not prompt-scoped; sharing these sessions with unrelated clients defeats that guarantee.
- Each request submits exactly one previously unseen user text message. Prior history is not replayed. Initial history import, multiple new user turns, client tools, shared state/context, multimodal input, and streaming reconnect are rejected. System/developer text is sent as per-prompt OpenCode system instructions.
- The bridge consumes `server.connected` before sending the prompt because the SDK subscription is lazy. Assistant `parentID` must match the server-generated prompt message ID. Idle alone never completes a run. Only a correlated completed assistant response ends the turn; tool-call intermediate completions do not.
- Authoritative part snapshots and event IDs suppress duplicate text/tool events. Text revisions emit `MESSAGES_SNAPSHOT` with preserved conversation history because AG-UI text deltas cannot retract content. Server tool inputs are emitted when authoritative, followed by one result. Failed tool output and SDK/provider errors are redacted.
- Disconnect/timeout aborts only a run that acquired its own thread lock and submitted a prompt or interrupt reply. A rejected competing request never aborts the active caller. Completion wins once persisted. Default active-run timeout is 120 seconds.
- A process crash or failed abort deliberately leaves a lock/active marker instead of silently replaying a turn. To recover: stop all bridge processes using the store, inspect and abort the mapped session in OpenCode, then remove that record's `.lock` and clear its `active`, `pending`, and `mapper` fields while preserving `sessionID` and `consumed`. Only then restart. Never remove an active process's lock. Automatic stream replay is not supported; `Last-Event-ID` requests return HTTP 409.
- Protect and back up the store: it can contain conversation text, tool arguments/output, and pending approval details. Use a dedicated OpenCode server and sandbox directory with explicit OpenCode permissions. Authentication is not an OS sandbox; OpenCode tools can execute code as the server user.

## Permission and question interrupts

An OpenCode permission request ends the current AG-UI run with:

```json
{
  "type": "RUN_FINISHED",
  "threadId": "thread",
  "runId": "run",
  "outcome": {
    "type": "interrupt",
    "interrupts": [
      {
        "id": "opaque-bridge-id",
        "reason": "permission",
        "message": "Allow read?"
      }
    ]
  }
}
```

A later run on the same authorized owner/thread/directory supplies:

```json
{
  "threadId": "thread",
  "runId": "new-run",
  "messages": [],
  "resume": [
    {
      "interruptId": "opaque-bridge-id",
      "status": "resolved",
      "payload": { "reply": "once" }
    }
  ]
}
```

Permission replies are exactly `once`, `always`, or `reject`; `status: "cancelled"` sends `reject`. An explicit denial/cancellation aborts the paused session and completes the AG-UI run with `outcome: { "type": "cancelled" }`; OpenCode does not guarantee a final assistant reply after denial. Nothing is automatically approved. Questions use their separate API and `payload: { "answers": [["Blue"]] }`, with one answer array per question. Cancelled question answers call `question.reject()`.

Pending interrupts persist across a bridge restart, including the mapped OpenCode request, correlation, and mapper state. The bridge validates the stored interrupt and current pending request/session before replying. An in-flight reply is marked durably before its side effect, preventing a crash from replaying an approval. Invalid answers leave the interrupt answerable; stale/duplicate/foreign answers fail. OpenCode itself must remain running to retain its pending requests.

Default interrupt TTL is five minutes; an expired answer aborts the paused OpenCode session and clears the interrupt. Expiry is enforced when a resume is attempted, not by a background scheduler. Supply `interruptTtlMs` and `timeoutMs` when constructing the bridge to change these limits.

The Dojo's `/opencode/feature/interrupt` page renders these native permission and question interrupts. For a real-server permission demo, set `permission: { "bash": "ask" }` in the OpenCode project configuration and ask the agent to run a shell command. The page offers allow once, always allow, and deny for permissions; it displays choices or a custom answer for questions. The separate generic `human_in_the_loop` Dojo page demonstrates a tool-driven flow and is not used by OpenCode.

## Validation and Dojo

Credential-free unit and real-SDK HTTP integration tests:

```sh
pnpm exec nx run-many -p @ag-ui/opencode -t lint,typecheck,test
```

Optional real OpenCode binary contract test (local deterministic model endpoint, no model credentials):

```sh
pnpm exec nx run @ag-ui/opencode:test-live
# Optional: OPENCODE_BIN=/path/to/opencode OPENCODE_TRACE_OUTPUT=/tmp/trace.json
```

This exercises actual OpenCode text/tool/permission/question/error/abort events and checks the live `/doc` contract. The default test suite skips it unless explicitly enabled; CI uses the HTTP fixture so installing OpenCode is not required.

Dojo and browser test, in separate terminals:

```sh
OPENCODE_FIXTURE=1 node apps/dojo/scripts/prep-dojo-everything.js --only dojo,opencode
OPENCODE_FIXTURE=1 node apps/dojo/scripts/run-dojo-everything.js --only dojo,opencode
pnpm --dir apps/dojo/e2e install --ignore-scripts
pnpm --dir apps/dojo/e2e exec playwright install chromium
BASE_URL=http://localhost:9999 pnpm exec nx run @ag-ui/opencode:test-e2e
```

For a separately configured real model, run the two-turn smoke (normal provider billing may apply):

```sh
OPENCODE_URL=http://127.0.0.1:4096 \
OPENCODE_DIRECTORY=/path/to/disposable-project \
OPENCODE_SERVER_PASSWORD=local-server-password \
pnpm exec nx run @ag-ui/opencode:smoke
```

Representative text event sequence:

```jsonl
{"type":"RUN_STARTED","threadId":"thread","runId":"run"}
{"type":"TEXT_MESSAGE_START","messageId":"assistant:part","role":"assistant"}
{"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant:part","delta":"Hello "}
{"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant:part","delta":"world."}
{"type":"TEXT_MESSAGE_END","messageId":"assistant:part"}
{"type":"RUN_FINISHED","threadId":"thread","runId":"run","outcome":{"type":"success"}}
```
