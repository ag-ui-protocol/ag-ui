import 'package:agui/agui.dart';
import 'package:agui/src/pipeline/apply.dart';
import 'package:test/test.dart';

final class _Agent extends AbstractAgent {
  _Agent({super.initialMessages, super.initialState}) : super(threadId: 't');

  @override
  Stream<Map<String, Object?>> connect(RunAgentInput input) =>
      const Stream.empty();
}

/// An agent plus the warnings applying events to it produced.
final class _Harness {
  _Harness({List<Map<String, Object?>>? messages, Object? state})
    : agent = _Agent(
        initialMessages: messages?.map(Message.fromJson).toList(),
        initialState: state ?? const <String, Object?>{},
      );

  final _Agent agent;
  final List<String> warnings = [];

  Future<List<Event>> apply(List<Map<String, Object?>> raw) =>
      applyEvents(
        agent,
        agent.prepareRunAgentInput(runId: 'r'),
        Stream.fromIterable(raw.map(Event.fromJson)),
        warnings.add,
      ).toList();

  List<Map<String, Object?>> get messages => [
    for (final m in agent.messages) m.toJson(),
  ];
}

Map<String, Object?> textStart(String id, {String? role}) => {
  'type': 'TEXT_MESSAGE_START',
  'messageId': id,
  if (role != null) 'role': role,
};

Map<String, Object?> textContent(String id, String delta) => {
  'type': 'TEXT_MESSAGE_CONTENT',
  'messageId': id,
  'delta': delta,
};

Map<String, Object?> textEnd(String id) => {
  'type': 'TEXT_MESSAGE_END',
  'messageId': id,
};

Map<String, Object?> toolStart(String id, String name, {String? parent}) => {
  'type': 'TOOL_CALL_START',
  'toolCallId': id,
  'toolCallName': name,
  if (parent != null) 'parentMessageId': parent,
};

Map<String, Object?> toolArgs(String id, String delta) => {
  'type': 'TOOL_CALL_ARGS',
  'toolCallId': id,
  'delta': delta,
};

Map<String, Object?> toolEnd(String id) => {
  'type': 'TOOL_CALL_END',
  'toolCallId': id,
};

Map<String, Object?> toolResult(String messageId, String id, Object content) =>
    {
      'type': 'TOOL_CALL_RESULT',
      'messageId': messageId,
      'toolCallId': id,
      'content': content,
    };

Map<String, Object?> activity(
  String id,
  Map<String, Object?> content, {
  String type = 'plan',
}) => {'id': id, 'role': 'activity', 'activityType': type, 'content': content};

Map<String, Object?> runFinished([Map<String, Object?>? outcome]) => {
  'type': 'RUN_FINISHED',
  'threadId': 't',
  'runId': 'r',
  if (outcome != null) 'outcome': outcome,
};

void main() {
  group('text messages', () {
    test('the triad builds an assistant message with its content', () async {
      final h = _Harness();
      final events = await h.apply([
        textStart('m1'),
        textContent('m1', 'Hel'),
        textContent('m1', 'lo'),
        textEnd('m1'),
      ]);
      expect(events, hasLength(4));
      expect(h.messages, [
        {'id': 'm1', 'role': 'assistant', 'content': 'Hello'},
      ]);
      expect(h.warnings, isEmpty);
    });

    test('a start for another role creates that role', () async {
      final h = _Harness();
      await h.apply([textStart('u', role: 'user'), textContent('u', 'hi')]);
      expect(h.messages, [
        {'id': 'u', 'role': 'user', 'content': 'hi'},
      ]);
    });

    test('content for an existing message id appends to it', () async {
      final h = _Harness(
        messages: [
          {'id': 'm1', 'role': 'assistant', 'content': 'Hi'},
        ],
      );
      await h.apply([textStart('m1'), textContent('m1', ' there')]);
      expect(h.messages, [
        {'id': 'm1', 'role': 'assistant', 'content': 'Hi there'},
      ]);
    });

    test('content for an unknown message warns', () async {
      final h = _Harness();
      await h.apply([textContent('x', 'a'), textEnd('x')]);
      expect(h.messages, isEmpty);
      expect(h.warnings, [
        "TEXT_MESSAGE_CONTENT: No message found with ID 'x'",
        "TEXT_MESSAGE_END: No message found with ID 'x'",
      ]);
    });

    test('a start reusing an activity message id warns and drops', () async {
      final h = _Harness(
        messages: [
          activity('a1', {'step': 1}),
        ],
      );
      await h.apply([
        {
          ...textStart('a1'),
          'metadata': {'k': 1},
        },
        textContent('a1', 'x'),
        textEnd('a1'),
      ]);
      expect(h.messages, [
        activity('a1', {'step': 1}),
      ]);
      expect(h.warnings, hasLength(3));
      expect(
        h.warnings.first,
        "TEXT_MESSAGE_START: Message 'a1' is an activity message — message "
        'ids must be unique across activity and text messages',
      );
    });
  });

  group('tool calls', () {
    test(
      'the triad and a string result build the call and a tool message',
      () async {
        final h = _Harness();
        await h.apply([
          toolStart('c1', 'search'),
          toolArgs('c1', '{"q":'),
          toolArgs('c1', '"x"}'),
          toolEnd('c1'),
          toolResult('r1', 'c1', 'found'),
        ]);
        expect(h.messages, [
          {
            'id': 'c1',
            'role': 'assistant',
            'toolCalls': [
              {
                'id': 'c1',
                'type': 'function',
                'function': {'name': 'search', 'arguments': '{"q":"x"}'},
              },
            ],
          },
          {'id': 'r1', 'role': 'tool', 'content': 'found', 'toolCallId': 'c1'},
        ]);
        expect(h.warnings, isEmpty);
      },
    );

    test('a parts result is kept as parts', () async {
      final h = _Harness();
      await h.apply([
        toolStart('c1', 'see'),
        toolEnd('c1'),
        toolResult('r1', 'c1', [
          {'type': 'text', 'text': 'a picture'},
        ]),
      ]);
      final tool = h.agent.messages.last as ToolMessage;
      expect(tool.content, isA<List<ContentPart>>());
      expect(h.messages.last['content'], [
        {'type': 'text', 'text': 'a picture'},
      ]);
    });

    test(
      'parentMessageId attaches the call to an existing assistant message',
      () async {
        final h = _Harness();
        await h.apply([
          textStart('m1'),
          textContent('m1', 'Let me look'),
          textEnd('m1'),
          toolStart('c1', 'search', parent: 'm1'),
          toolStart('c2', 'fetch', parent: 'm1'),
        ]);
        expect(h.agent.messages, hasLength(1));
        final m = h.agent.messages.single as AssistantMessage;
        expect(m.content, 'Let me look');
        expect(m.toolCalls!.map((c) => c.id), ['c1', 'c2']);
      },
    );

    test(
      'an unknown parentMessageId names the new assistant message',
      () async {
        final h = _Harness();
        await h.apply([toolStart('c1', 'x', parent: 'p1')]);
        expect(h.messages.single['id'], 'p1');
      },
    );

    test(
      'a parentMessageId naming a non-assistant falls back with a warning',
      () async {
        final h = _Harness(
          messages: [
            {'id': 'u1', 'role': 'user', 'content': 'hi'},
          ],
        );
        await h.apply([toolStart('c1', 'x', parent: 'u1')]);
        expect(h.agent.messages.map((m) => m.id), ['u1', 'c1']);
        expect(h.warnings.single, contains("matches a 'user' message"));
      },
    );

    test(
      'a replayed start updates the existing call instead of adding one',
      () async {
        final h = _Harness();
        await h.apply([
          toolStart('c1', 'a'),
          toolArgs('c1', '{}'),
          toolStart('c1', 'b'),
        ]);
        final m = h.agent.messages.single as AssistantMessage;
        expect(m.toolCalls, hasLength(1));
        expect(m.toolCalls!.single.function.name, 'b');
        expect(m.toolCalls!.single.function.arguments, '{}');
        expect(h.warnings.single, contains("already exists with name 'a'"));
      },
    );

    test('args for an unknown call warn', () async {
      final h = _Harness();
      await h.apply([toolArgs('nope', '{}'), toolEnd('nope')]);
      expect(h.warnings, [
        "TOOL_CALL_ARGS: No message found containing tool call with ID 'nope'",
        "TOOL_CALL_END: No message found containing tool call with ID 'nope'",
      ]);
    });

    test(
      'a result lands right after its owner, after earlier results',
      () async {
        final h = _Harness();
        await h.apply([
          toolStart('c1', 'a', parent: 'm1'),
          toolStart('c2', 'b', parent: 'm1'),
          textStart('m2'),
          textContent('m2', 'follow-up'),
          toolResult('r1', 'c1', 'one'),
          toolResult('r2', 'c2', 'two'),
          // The id lookup must survive the insertions above.
          textContent('m2', '!'),
        ]);
        expect(h.agent.messages.map((m) => m.id), ['m1', 'r1', 'r2', 'm2']);
        expect(
          (h.agent.messages.last as AssistantMessage).content,
          'follow-up!',
        );
      },
    );

    test('a result without an owner is appended', () async {
      final h = _Harness();
      await h.apply([toolResult('r1', 'ghost', 'x')]);
      expect(h.agent.messages.map((m) => m.id), ['r1']);
    });
  });

  group('state', () {
    test('a snapshot replaces the state, whatever its shape', () async {
      for (final snapshot in <Object?>[
        null,
        false,
        0,
        [1, 2],
        {'a': 1},
      ]) {
        final h = _Harness(state: {'old': true});
        await h.apply([
          {'type': 'STATE_SNAPSHOT', 'snapshot': snapshot},
        ]);
        expect(h.agent.state, snapshot);
      }
    });

    test('a delta applies', () async {
      final h = _Harness(state: {'count': 1});
      await h.apply([
        {
          'type': 'STATE_DELTA',
          'delta': [
            {'op': 'replace', 'path': '/count', 'value': 2},
            {'op': 'add', 'path': '/items', 'value': <Object?>[]},
          ],
        },
      ]);
      expect(h.agent.state, {'count': 2, 'items': <Object?>[]});
    });

    test('a failing delta keeps the old state and warns', () async {
      final h = _Harness(state: {'count': 1});
      await h.apply([
        {
          'type': 'STATE_DELTA',
          'delta': [
            {'op': 'replace', 'path': '/count', 'value': 2},
            {'op': 'remove', 'path': '/missing'},
          ],
        },
      ]);
      expect(h.agent.state, {'count': 1});
      expect(h.warnings, hasLength(1));
      expect(
        h.warnings.single,
        startsWith('Failed to apply state patch:\nCurrent state: {\n'),
      );
      expect(h.warnings.single, contains('\nPatch operations: [\n'));
      expect(h.warnings.single, contains('\nError: '));
    });
  });

  group('messages snapshot', () {
    test(
      'reconciles by id: updates, drops, appends, keeps client-only ones',
      () async {
        final h = _Harness(
          messages: [
            {'id': 'u1', 'role': 'user', 'content': 'old'},
            {'id': 'gone', 'role': 'assistant', 'content': 'x'},
            activity('a1', {'s': 1}),
            {'id': 'rz', 'role': 'reasoning', 'content': 'thinking'},
          ],
        );
        await h.apply([
          {
            'type': 'MESSAGES_SNAPSHOT',
            'messages': [
              {'id': 'u1', 'role': 'user', 'content': 'new'},
              {'id': 'm2', 'role': 'assistant', 'content': 'added'},
            ],
          },
          // The id index is rebuilt: content for an appended message works.
          textContent('m2', '!'),
        ]);
        expect(h.messages, [
          {'id': 'u1', 'role': 'user', 'content': 'new'},
          activity('a1', {'s': 1}),
          {'id': 'rz', 'role': 'reasoning', 'content': 'thinking'},
          {'id': 'm2', 'role': 'assistant', 'content': 'added!'},
        ]);
      },
    );

    test(
      'a snapshot carrying activity and reasoning owns those kinds',
      () async {
        final h = _Harness(
          messages: [
            activity('a1', {'s': 1}),
            {'id': 'rz', 'role': 'reasoning', 'content': 'old'},
          ],
        );
        await h.apply([
          {
            'type': 'MESSAGES_SNAPSHOT',
            'messages': [
              activity('a2', {'s': 2}),
              {'id': 'rz2', 'role': 'reasoning', 'content': 'canonical'},
            ],
          },
        ]);
        expect(h.agent.messages.map((m) => m.id), ['a2', 'rz2']);
      },
    );

    test(
      'declared authority limits which activity types are replaced',
      () async {
        final h = _Harness(
          messages: [
            activity('a1', {}, type: 'plan'),
            activity('a2', {}, type: 'search'),
          ],
        );
        await h.apply([
          {
            'type': 'MESSAGES_SNAPSHOT',
            'messages': <Object?>[],
            'metadata': {
              '@ag-ui/client': {
                'authoritativeActivityTypes': ['plan'],
              },
            },
          },
        ]);
        expect(h.agent.messages.map((m) => m.id), ['a2']);

        final all = _Harness(messages: [activity('a1', {})]);
        await all.apply([
          {
            'type': 'MESSAGES_SNAPSHOT',
            'messages': <Object?>[],
            'metadata': {
              '@ag-ui/client': {'authoritativeActivityTypes': null},
            },
          },
        ]);
        expect(all.agent.messages, isEmpty);
      },
    );
  });

  group('activity', () {
    test(
      'a snapshot creates, replaces, or leaves alone when replace is false',
      () async {
        final h = _Harness();
        await h.apply([
          {
            'type': 'ACTIVITY_SNAPSHOT',
            'messageId': 'a1',
            'activityType': 'plan',
            'content': {'step': 1},
            'metadata': {'k': 'v'},
          },
          {
            'type': 'ACTIVITY_SNAPSHOT',
            'messageId': 'a1',
            'activityType': 'plan',
            'content': {'step': 2},
            'replace': false,
          },
        ]);
        expect(h.messages, [
          {
            ...activity('a1', {'step': 1}),
            'metadata': {'k': 'v'},
          },
        ]);

        await h.apply([
          {
            'type': 'ACTIVITY_SNAPSHOT',
            'messageId': 'a1',
            'activityType': 'plan2',
            'content': {'step': 3},
          },
        ]);
        // Replace swaps content and type but keeps the accumulated metadata.
        expect(h.messages, [
          {
            ...activity('a1', {'step': 3}, type: 'plan2'),
            'metadata': {'k': 'v'},
          },
        ]);
      },
    );

    test(
      'a replacing snapshot over a non-activity message replaces it',
      () async {
        final h = _Harness(
          messages: [
            {'id': 'x', 'role': 'assistant', 'content': 'hi'},
          ],
        );
        await h.apply([
          {
            'type': 'ACTIVITY_SNAPSHOT',
            'messageId': 'x',
            'activityType': 'plan',
            'content': {'s': 1},
            'replace': false,
          },
        ]);
        expect(h.agent.messages.single, isA<AssistantMessage>());
        await h.apply([
          {
            'type': 'ACTIVITY_SNAPSHOT',
            'messageId': 'x',
            'activityType': 'plan',
            'content': {'s': 1},
          },
        ]);
        expect(h.messages, [
          activity('x', {'s': 1}),
        ]);
      },
    );

    test('a delta patches the content', () async {
      final h = _Harness(
        messages: [
          activity('a1', {
            'steps': ['a'],
          }),
        ],
      );
      await h.apply([
        {
          'type': 'ACTIVITY_DELTA',
          'messageId': 'a1',
          'activityType': 'plan',
          'patch': [
            {'op': 'add', 'path': '/steps/-', 'value': 'b'},
          ],
        },
      ]);
      expect(h.messages, [
        activity('a1', {
          'steps': ['a', 'b'],
        }),
      ]);
    });

    test('a delta for a missing message is tolerated silently', () async {
      final h = _Harness();
      await h.apply([
        {
          'type': 'ACTIVITY_DELTA',
          'messageId': 'nope',
          'activityType': 'plan',
          'patch': [
            {'op': 'add', 'path': '/a', 'value': 1},
          ],
        },
      ]);
      expect(h.messages, isEmpty);
      expect(h.warnings, isEmpty);
    });

    test('a failing delta keeps the content but merges the metadata', () async {
      final h = _Harness(
        messages: [
          activity('a1', {'s': 1}),
        ],
      );
      await h.apply([
        {
          'type': 'ACTIVITY_DELTA',
          'messageId': 'a1',
          'activityType': 'plan',
          'patch': [
            {'op': 'remove', 'path': '/missing'},
          ],
          'metadata': {'usage': 1},
        },
      ]);
      expect(h.messages, [
        {
          ...activity('a1', {'s': 1}),
          'metadata': {'usage': 1},
        },
      ]);
      expect(
        h.warnings.single,
        startsWith("Failed to apply activity patch for 'a1': "),
      );
    });

    test('a delta on a non-activity message warns', () async {
      final h = _Harness(
        messages: [
          {'id': 'u', 'role': 'user', 'content': 'x'},
        ],
      );
      await h.apply([
        {
          'type': 'ACTIVITY_DELTA',
          'messageId': 'u',
          'activityType': 'plan',
          'patch': <Object?>[],
        },
      ]);
      expect(h.warnings, [
        "ACTIVITY_DELTA: Message 'u' is not an activity message",
      ]);
    });
  });

  group('reasoning', () {
    test('the triad builds a reasoning message', () async {
      final h = _Harness();
      await h.apply([
        {'type': 'REASONING_START', 'messageId': 'g'},
        {
          'type': 'REASONING_MESSAGE_START',
          'messageId': 'rz',
          'role': 'reasoning',
        },
        {'type': 'REASONING_MESSAGE_CONTENT', 'messageId': 'rz', 'delta': 'th'},
        {
          'type': 'REASONING_MESSAGE_CONTENT',
          'messageId': 'rz',
          'delta': 'ink',
        },
        {'type': 'REASONING_MESSAGE_END', 'messageId': 'rz'},
        {'type': 'REASONING_END', 'messageId': 'g'},
      ]);
      expect(h.messages, [
        {'id': 'rz', 'role': 'reasoning', 'content': 'think'},
      ]);
      expect(h.warnings, isEmpty);
    });

    test('an encrypted value attaches to a message or a tool call', () async {
      final h = _Harness();
      await h.apply([
        textStart('m1'),
        toolStart('c1', 'x', parent: 'm1'),
        {
          'type': 'REASONING_ENCRYPTED_VALUE',
          'subtype': 'message',
          'entityId': 'm1',
          'encryptedValue': 'em',
        },
        {
          'type': 'REASONING_ENCRYPTED_VALUE',
          'subtype': 'tool-call',
          'entityId': 'c1',
          'encryptedValue': 'ec',
        },
        {
          'type': 'REASONING_ENCRYPTED_VALUE',
          'subtype': 'message',
          'entityId': 'unknown',
          'encryptedValue': 'x',
        },
        {
          'type': 'REASONING_ENCRYPTED_VALUE',
          'subtype': 'tool-call',
          'entityId': 'unknown',
          'encryptedValue': 'x',
        },
      ]);
      final m = h.agent.messages.single as AssistantMessage;
      expect(m.encryptedValue, 'em');
      expect(m.toolCalls!.single.encryptedValue, 'ec');
      expect(h.warnings, isEmpty);
    });
  });

  group('metadata', () {
    test(
      'merges onto the message key by key, the last write winning',
      () async {
        final h = _Harness();
        await h.apply([
          {
            ...textStart('m1'),
            'metadata': {'a': 1, 'b': 1},
          },
          {
            ...textContent('m1', 'x'),
            'metadata': {'b': 2},
          },
          {
            ...textEnd('m1'),
            'metadata': {'usage': 7},
          },
        ]);
        expect(h.agent.messages.single.metadata, {'a': 1, 'b': 2, 'usage': 7});
      },
    );

    test('merges onto the tool call, not its parent message', () async {
      final h = _Harness();
      await h.apply([
        {
          ...toolStart('c1', 'x'),
          'metadata': {'a': 1},
        },
        {
          ...toolEnd('c1'),
          'metadata': {'a': 2, 'z': 0},
        },
      ]);
      final m = h.agent.messages.single as AssistantMessage;
      expect(m.metadata, isNull);
      expect(m.toolCalls!.single.metadata, {'a': 2, 'z': 0});
    });
  });

  group('run lifecycle', () {
    Map<String, Object?> runStarted([String? version]) => {
      'type': 'RUN_STARTED',
      'threadId': 't',
      'runId': 'r',
      if (version != null) 'protocolVersion': version,
    };

    test('a newer declaration warns', () async {
      final h = _Harness();
      await h.apply([runStarted('1.1')]);
      expect(h.warnings.single, contains('1.1'));
    });

    test('an uninterpretable declaration warns', () async {
      final h = _Harness();
      await h.apply([runStarted('abc')]);
      expect(h.warnings.single, contains('cannot interpret'));
    });

    test('an equal or absent declaration is silent', () async {
      final h = _Harness();
      await h.apply([runStarted('1.0'), runStarted()]);
      expect(h.warnings, isEmpty);
    });

    test('input messages not already present are added', () async {
      final h = _Harness(
        messages: [
          {'id': 'u1', 'role': 'user', 'content': 'kept'},
        ],
      );
      await h.apply([
        {
          ...runStarted(),
          'input': {
            'threadId': 't',
            'runId': 'r',
            'state': <String, Object?>{},
            'messages': [
              {'id': 'u1', 'role': 'user', 'content': 'replayed'},
              {'id': 'u2', 'role': 'user', 'content': 'new'},
            ],
            'tools': <Object?>[],
            'context': <Object?>[],
            'forwardedProps': <String, Object?>{},
          },
        },
      ]);
      expect(h.messages, [
        {'id': 'u1', 'role': 'user', 'content': 'kept'},
        {'id': 'u2', 'role': 'user', 'content': 'new'},
      ]);
    });

    test(
      'an interrupt outcome sets pendingInterrupts; the next finish clears',
      () async {
        final h = _Harness();
        await h.apply([
          runFinished({
            'type': 'interrupt',
            'interrupts': [
              {'id': 'i1', 'reason': 'approval'},
            ],
          }),
        ]);
        expect(h.agent.pendingInterrupts.map((i) => i.id), ['i1']);

        await h.apply([runFinished()]);
        expect(h.agent.pendingInterrupts, isEmpty);
      },
    );

    test('events are yielded after they are applied', () async {
      final h = _Harness();
      final seen = <String?>[];
      await applyEvents(
        h.agent,
        h.agent.prepareRunAgentInput(runId: 'r'),
        Stream.fromIterable(
          [textStart('m1'), textContent('m1', 'a')].map(Event.fromJson),
        ),
        h.warnings.add,
      ).forEach((_) {
        final last = h.agent.messages.lastOrNull;
        seen.add(last is AssistantMessage ? last.content : null);
      });
      expect(seen, ['', 'a']);
    });
  });

  group('chunk events', () {
    for (final (type, body) in [
      ('TEXT_MESSAGE_CHUNK', <String, Object?>{'messageId': 'm', 'delta': 'x'}),
      ('TOOL_CALL_CHUNK', <String, Object?>{'toolCallId': 'c', 'delta': 'x'}),
      (
        'REASONING_MESSAGE_CHUNK',
        <String, Object?>{'messageId': 'm', 'delta': 'x'},
      ),
    ]) {
      test('$type must be transformed first', () async {
        final h = _Harness();
        await expectLater(
          h.apply([
            {'type': type, ...body},
          ]),
          throwsA(
            isA<StateError>().having(
              (e) => e.message,
              'message',
              '$type must be transformed before being applied',
            ),
          ),
        );
      });
    }
  });

  test('subscriber-only events are yielded and change nothing', () async {
    final h = _Harness(state: {'s': 1});
    final events = await h.apply([
      {'type': 'STEP_STARTED', 'stepName': 'a'},
      {'type': 'STEP_FINISHED', 'stepName': 'a'},
      {'type': 'RAW', 'event': 1},
      {'type': 'CUSTOM', 'name': 'n', 'value': 1},
      {'type': 'RUN_ERROR', 'message': 'boom'},
    ]);
    expect(events, hasLength(5));
    expect(h.agent.messages, isEmpty);
    expect(h.agent.state, {'s': 1});
  });
}
