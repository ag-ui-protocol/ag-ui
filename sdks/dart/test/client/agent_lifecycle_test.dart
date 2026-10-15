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

  test('a run stream that is never listened to locks nothing', () async {
    final agent = scripted(const [
      {'type': 'RUN_STARTED', 'threadId': 't', 'runId': 'r'},
      {'type': 'RUN_FINISHED', 'threadId': 't', 'runId': 'r'},
    ]);
    agent.run();
    expect(agent.isRunning, isFalse);
    await agent.runAgent();
    expect(agent.isRunning, isFalse);
  });

  test(
    'two streams obtained before either is listened to do not both run',
    () async {
      final agent = ScriptedAgent((_) async* {
        yield {'type': 'RUN_STARTED', 'threadId': 't', 'runId': 'r'};
        await Future<void>.delayed(const Duration(milliseconds: 10));
        yield {'type': 'RUN_FINISHED', 'threadId': 't', 'runId': 'r'};
      });
      final first = agent.run();
      final second = agent.run();
      final firstDone = first.toList();
      await expectLater(second.toList(), throwsA(isA<AguiStateException>()));
      expect((await firstDone).length, 2);
    },
  );

  test('an invalid peer ceiling is rejected at construction', () {
    expect(
      () => scripted(const [], maxProtocolVersion: 'latest'),
      throwsArgumentError,
    );
    expect(
      () => scripted(const [], maxProtocolVersion: '0.0.45-beta.1'),
      throwsArgumentError,
    );
    expect(
      () => scripted(const [], maxProtocolVersion: '0.0.45'),
      returnsNormally,
    );
  });

  test('messages get a fresh read-only view per applied event', () async {
    final agent = scripted(const [
      {'type': 'RUN_STARTED', 'threadId': 't', 'runId': 'r'},
      {'type': 'TEXT_MESSAGE_START', 'messageId': 'm'},
      {'type': 'TEXT_MESSAGE_CONTENT', 'messageId': 'm', 'delta': 'x'},
      {'type': 'TEXT_MESSAGE_END', 'messageId': 'm'},
      {'type': 'RUN_FINISHED', 'threadId': 't', 'runId': 'r'},
    ]);
    final seen = <List<Message>>[];
    await for (final _ in agent.run()) {
      seen.add(agent.messages);
    }
    expect(seen.map((l) => l.length), [0, 1, 1, 1, 1]);
    expect(identical(seen[1], seen[2]), isFalse);
    expect(
      () => agent.messages.add(const UserMessage(id: 'x', content: 'y')),
      throwsUnsupportedError,
    );
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
