# Pi for AG-UI

`@ag-ui/pi` converts native Pi events and history into typed AG-UI events and messages. Use the translator with Pi agent-core or a Pi coding session. The example serves a coding session over HTTP so the web Dojo and Flutter Dojo can use the same agent.

## Run the example

Use Node 22.19 or later. Set `OPENAI_API_KEY` in the server environment. The example defaults to `gpt-4o-mini` on the OpenAI chat completions endpoint. Set `OPENAI_BASE_URL` and `OPENAI_MODEL` to use another compatible provider. From the repository root, run:

```sh
pnpm install --frozen-lockfile
pnpm nx run @ag-ui/pi:build
HOST=127.0.0.1 PORT=8032 pnpm --filter @ag-ui/pi start
```

The npm archive also contains the compiled example. In a project with the package installed, start it with `npm explore @ag-ui/pi -- npm start`.

POST a `RunAgentInput` to `/agentic_chat`. Supply the conversation so far, including the new user message or the client's tool results. Each request opens an in-memory Pi session. The example restores prior messages, runs the new turn, and streams AG-UI events using the official encoder. The default bind address is `0.0.0.0` and the default port is `8032`. The example allows browser requests from loopback origins.

### Connect a Dojo

- **Flutter**. From `sdks/community/dart/example`, run `flutter pub get`, then `flutter run -d chrome --dart-define=AG_UI_BASE_URL=http://127.0.0.1:8032`. Open **Agentic Chat** and ask it to use `calculate` for `6 * 7`. Flutter reads the proposed tool call from the messages snapshot, executes it, and sends the result back to Pi. [Flutter setup](../../../../sdks/community/dart/example/README.md)
- **Web Dojo**. Select the `pi` service with the Dojo prep and run scripts. Set `PI_URL` to the example's base URL when running it separately. Open **Pi → Agentic Chat**. [Dojo scripts](../../../../apps/dojo/scripts)

## Embed the translator

```ts
import { createTranslator, toAguiMessages } from "@ag-ui/pi";

const translator = createTranslator({
  threadId,
  runId,
  completion: "caller",
  messageId: assignMessageId,
  getMessages: () => toAguiMessages(loadHistoryEntries()),
});

emit(translator.start());
const unsubscribe = session.subscribe((event) => emit(translator.translate(event)));
try {
  await executeHostRun();
  emit(translator.finish());
} catch {
  emit(translator.error("The run failed"));
} finally {
  unsubscribe();
}
```

In this sketch, `emit` accepts an array of events. The host supplies its IDs and lifecycle. Give `toAguiMessages` entries shaped as `{ id, message }`, each containing a stable ID and a native Pi message. Use the same IDs for streaming and history. Without an ID callback the translator allocates IDs within the run.

Choose `completion: "caller"` when the host decides whether to finish, fail, or continue after Pi stops. Choose `"session"` when Pi's `agent_settled` should finish the run after any retries. A host calling `error` supplies a message suitable for display to the client.

## Feature matrix

| Capability | Support |
| --- | --- |
| Agentic Chat | Streams split assistant text and preserves text history across requests. |
| Pi tool calls | Sends the proposed name and complete JSON arguments when Pi commits the call. Emits one correlated result when Pi supplies the native result. |
| Client tools in the example | Ends the run with a snapshot containing the pending proposal. The client executes it and resubmits the history with its actual result. |
| History projection | Preserves caller-supplied IDs, public text and tool calls. Internal messages and reasoning are omitted. |
| Run lifecycle | Supports success, public errors, caller-owned termination, coding-session settlement and disconnect cleanup in the standalone server. |
| Other Dojo features | State synchronization, approvals, multimodal input, and private reasoning are outside the example. |

The example runs with Pi's built-in coding tools disabled. A host owns authentication, persistence, cancellation policy, and any server-side tools it registers.

## Compatibility and verification

| Pi agent-core, pi-ai and pi-coding-agent | AG-UI client, core and encoder | Check |
| --- | --- | --- |
| 1.5.0 | 1.0.4 | Workspace build and official-client tests |
| 1.5.2 | 1.0.4 | Clean consumer installed from the npm tarball |

From the repository root:

```sh
pnpm nx run @ag-ui/pi:build
pnpm nx run @ag-ui/pi:typecheck
pnpm nx run @ag-ui/pi:test
pnpm --filter @ag-ui/pi test:pack
```

The packed test installs the tarball in a temporary npm project, checks the notices and declarations, and runs the core and HTTP tests against the installed files. The tests use a controlled provider and require no live API key.

AG-UI maintainers release `@ag-ui/pi` through the repository's `integration-pi` release scope. The [provenance record](PROVENANCE.md) lists the donor files and adaptations.
