import 'dart:io';

import 'package:agui/agui.dart';

/// Streams one turn from a running AG-UI agent and prints the assistant text.
///
/// Point it at any AG-UI endpoint, for example a dojo agent started with
/// `pnpm -C apps/dojo dev`: `dart run example/agui_example.dart
/// http://localhost:8000/agentic_chat`, or set AGUI_URL.
Future<void> main(List<String> args) async {
  final url = Uri.parse(
    args.isNotEmpty
        ? args.first
        : Platform.environment['AGUI_URL'] ??
            'http://localhost:8000/agentic_chat',
  );
  final agent = HttpAgent(
    url: url,
    initialMessages: [UserMessage(id: uuidV4(), content: 'Hello from Dart!')],
    onWarning: (message) => stderr.writeln(message),
  );
  await for (final event in agent.run()) {
    switch (event) {
      case TextMessageContentEvent(:final delta):
        stdout.write(delta);
      case RunFinishedEvent():
        stdout.writeln();
      default:
        break;
    }
  }
  stdout.writeln('messages: ${agent.messages.length}');
  // Releases the keep-alive connection; without it the VM lingers until the
  // socket times out.
  agent.close();
}
