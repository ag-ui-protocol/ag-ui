# AG-UI Dart SDK

A Dart client for the [AG-UI protocol](https://docs.ag-ui.com), generated from
the protocol's own schema. Pure Dart: it runs on the VM, in Flutter and on the
web, and depends on nothing but `package:http`.

This is the first-party package, at protocol version 1.0 and package version
`1.0.0-dev`. It is not on pub.dev yet; depend on it by path. The community
package `ag_ui` on pub.dev is a separate, older implementation.

```yaml
dependencies:
  agui:
    path: ../ag-ui/sdks/dart
```

## Usage

```dart
import 'package:agui/agui.dart';

final agent = HttpAgent(
  url: Uri.parse('http://localhost:8000/agentic_chat'),
  initialMessages: [UserMessage(id: uuidV4(), content: 'Hello!')],
  onWarning: print, // where tolerated protocol deviations are reported
);

await for (final event in agent.run()) {
  switch (event) {
    case TextMessageContentEvent(:final delta):
      stdout.write(delta);
    default:
      break;
  }
}
print(agent.messages); // the conversation, kept current as events apply
print(agent.state);    // the agent state, likewise
```

`run()` yields every event after it has been applied to `messages` and
`state`; `runAgent()` drains it and returns what the run added. A protocol
violation ends the stream with an `AguiProtocolException`; a non-2xx response
with an `AguiHttpException`; a malformed event with an `AguiDecodeException`;
a failed connection with the `http` package's `ClientException`. Call
`agent.close()` when you are done with an `HttpAgent` you did not give a
client to.

Talking to an agent built against a pre-1.0 AG-UI release? Pass its version
as `maxProtocolVersion` and the matching compatibility shims are installed.

## What is where

Everything under `lib/src/generated` is produced by `spec/generator` from
`spec/1.0/schema.json` and must not be edited; everything else is written by
hand. `AGENTS.md` describes the layout, the commands, the design rules and,
most importantly, what is not implemented yet.
