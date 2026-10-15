import 'dart:async';

import 'package:agui/agui.dart';
import 'package:test/test.dart';

import '../support/scripted_agent.dart';

void main() {
  test('a second run while one is active throws', () async {
    final gate = Completer<void>();
    final agent = ScriptedAgent((_) async* {
      yield {'type': 'RUN_STARTED', 'threadId': 't', 'runId': 'r'};
      await gate.future;
      yield {'type': 'RUN_FINISHED', 'threadId': 't', 'runId': 'r'};
    });
    final first = agent.run().toList();
    await Future<void>.delayed(Duration.zero);
    expect(agent.isRunning, isTrue);
    expect(() => agent.run(), throwsA(isA<AguiStateException>()));
    gate.complete();
    await first;
    expect(agent.isRunning, isFalse);
  });

  test('runAgent reports the new messages and the result', () async {
    final agent = scripted(
      [
        {'type': 'RUN_STARTED', 'threadId': 't', 'runId': 'r'},
        {'type': 'RUN_FINISHED', 'threadId': 't', 'runId': 'r', 'result': 42},
      ],
      initialMessages: const [UserMessage(id: 'u', content: 'hi')],
    );
    final result = await agent.runAgent();
    expect(result.result, 42);
    expect(result.newMessages, isEmpty);
    expect(agent.inputs.single.messages.single.id, 'u');
    expect(agent.inputs.single.protocolVersion, '1.0');
  });

  test('a transport error ends the run and clears the running flag', () async {
    final agent = ScriptedAgent((_) => Stream.error(StateError('down')));
    await expectLater(agent.run().toList(), throwsStateError);
    expect(agent.isRunning, isFalse);
  });
}
