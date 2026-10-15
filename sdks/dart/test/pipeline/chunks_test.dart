import 'package:agui/agui.dart';
import 'package:agui/src/pipeline/chunks.dart';
import 'package:test/test.dart';

typedef Json = Map<String, Object?>;

Stream<Event> _source(List<Json> raw) =>
    Stream.fromIterable(raw.map(Event.fromJson));

/// Runs the stage and returns the output in wire form.
Future<List<Json>> _expand(List<Json> raw) async => [
  for (final e in await transformChunks(_source(raw)).toList()) e.toJson(),
];

/// The output reduced to its event types.
Future<List<String>> _types(List<Json> raw) async => [
  for (final e in await _expand(raw)) e['type']! as String,
];

Future<void> _expectFatal(List<Json> raw, String message) => expectLater(
  transformChunks(_source(raw)).toList(),
  throwsA(
    isA<AguiProtocolException>().having(
      (e) => e.message,
      'message',
      contains(message),
    ),
  ),
);

Json _text({
  String? id,
  String? delta,
  String? role,
  String? name,
  String? sub,
  Json? metadata,
  Object? raw,
}) => {
  'type': 'TEXT_MESSAGE_CHUNK',
  if (id != null) 'messageId': id,
  if (delta != null) 'delta': delta,
  if (role != null) 'role': role,
  if (name != null) 'name': name,
  if (sub != null) 'subagentRunId': sub,
  if (metadata != null) 'metadata': metadata,
  if (raw != null) 'rawEvent': raw,
};

Json _tool({
  String? id,
  String? name,
  String? delta,
  String? parent,
  String? sub,
  Json? metadata,
  Object? raw,
}) => {
  'type': 'TOOL_CALL_CHUNK',
  if (id != null) 'toolCallId': id,
  if (name != null) 'toolCallName': name,
  if (delta != null) 'delta': delta,
  if (parent != null) 'parentMessageId': parent,
  if (sub != null) 'subagentRunId': sub,
  if (metadata != null) 'metadata': metadata,
  if (raw != null) 'rawEvent': raw,
};

Json _reasoning({
  String? id,
  String? delta,
  String? sub,
  Json? metadata,
  Object? raw,
}) => {
  'type': 'REASONING_MESSAGE_CHUNK',
  if (id != null) 'messageId': id,
  if (delta != null) 'delta': delta,
  if (sub != null) 'subagentRunId': sub,
  if (metadata != null) 'metadata': metadata,
  if (raw != null) 'rawEvent': raw,
};

const Json _runStarted = {'type': 'RUN_STARTED', 'threadId': 't', 'runId': 'r'};
const Json _runFinished = {
  'type': 'RUN_FINISHED',
  'threadId': 't',
  'runId': 'r',
};

void main() {
  group('triads assemble', () {
    test('a single text chunk becomes start, content and end', () async {
      expect(
        await _expand([
          _runStarted,
          _text(id: 'm', role: 'assistant', delta: 'Hi'),
          _runFinished,
        ]),
        [
          _runStarted,
          {'type': 'TEXT_MESSAGE_START', 'messageId': 'm', 'role': 'assistant'},
          {'type': 'TEXT_MESSAGE_CONTENT', 'messageId': 'm', 'delta': 'Hi'},
          {'type': 'TEXT_MESSAGE_END', 'messageId': 'm'},
          _runFinished,
        ],
      );
    });

    test(
      'several chunks with one id produce exactly one start and end',
      () async {
        final out = await _expand([
          _text(id: 'm', delta: 'a'),
          _text(id: 'm', delta: 'b'),
          _text(delta: 'c'),
          _runFinished,
        ]);
        expect(out.map((e) => e['type']), [
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_CONTENT',
          'TEXT_MESSAGE_CONTENT',
          'TEXT_MESSAGE_CONTENT',
          'TEXT_MESSAGE_END',
          'RUN_FINISHED',
        ]);
        expect(
          out.where((e) => e.containsKey('delta')).map((e) => e['delta']),
          ['a', 'b', 'c'],
        );
        expect(
          out.every(
            (e) => e['messageId'] == 'm' || e['type'] == 'RUN_FINISHED',
          ),
          isTrue,
        );
      },
    );

    test('a tool chunk becomes start, args and end', () async {
      expect(
        await _expand([
          _tool(id: 'tc', name: 'search', parent: 'pm', delta: '{"q":'),
          _tool(delta: '1}'),
          _runFinished,
        ]),
        [
          {
            'type': 'TOOL_CALL_START',
            'toolCallId': 'tc',
            'toolCallName': 'search',
            'parentMessageId': 'pm',
          },
          {'type': 'TOOL_CALL_ARGS', 'toolCallId': 'tc', 'delta': '{"q":'},
          {'type': 'TOOL_CALL_ARGS', 'toolCallId': 'tc', 'delta': '1}'},
          {'type': 'TOOL_CALL_END', 'toolCallId': 'tc'},
          _runFinished,
        ],
      );
    });

    test(
      'a tool start omits parentMessageId when the chunk has none',
      () async {
        final out = await _expand([_tool(id: 'tc', name: 'f')]);
        expect(out.single.containsKey('parentMessageId'), isFalse);
      },
    );

    test('a reasoning chunk becomes start, content and end', () async {
      expect(
        await _expand([
          _reasoning(id: 'r1', delta: 'think'),
          _reasoning(delta: 'ing'),
          _runFinished,
        ]),
        [
          {
            'type': 'REASONING_MESSAGE_START',
            'role': 'reasoning',
            'messageId': 'r1',
          },
          {
            'type': 'REASONING_MESSAGE_CONTENT',
            'messageId': 'r1',
            'delta': 'think',
          },
          {
            'type': 'REASONING_MESSAGE_CONTENT',
            'messageId': 'r1',
            'delta': 'ing',
          },
          {'type': 'REASONING_MESSAGE_END', 'messageId': 'r1'},
          _runFinished,
        ],
      );
    });

    test('a chunk without a delta opens without a content event', () async {
      expect(await _types([_text(id: 'm'), _text(delta: 'x'), _runFinished]), [
        'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_CONTENT',
        'TEXT_MESSAGE_END',
        'RUN_FINISHED',
      ]);
      expect(await _types([_tool(id: 't', name: 'f'), _runFinished]), [
        'TOOL_CALL_START',
        'TOOL_CALL_END',
        'RUN_FINISHED',
      ]);
    });

    test('an empty delta is a delta', () async {
      final out = await _expand([_text(id: 'm', delta: '')]);
      expect(out.last, {
        'type': 'TEXT_MESSAGE_CONTENT',
        'messageId': 'm',
        'delta': '',
      });
    });

    test(
      'a continuation with neither delta nor metadata emits nothing',
      () async {
        expect(await _types([_text(id: 'm', delta: 'a'), _text()]), [
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_CONTENT',
        ]);
      },
    );
  });

  group('roles and names', () {
    test('role defaults to assistant on the synthesized start', () async {
      final out = await _expand([_text(id: 'm', delta: 'a')]);
      expect(out.first['role'], 'assistant');
    });

    test('an explicit role is kept', () async {
      final out = await _expand([
        _text(id: 'm1', role: 'user', delta: 'a'),
        _text(id: 'm2', role: 'system', delta: 'b'),
        _text(id: 'm3', role: 'developer', delta: 'c'),
      ]);
      expect(
        out
            .where((e) => e['type'] == 'TEXT_MESSAGE_START')
            .map((e) => e['role']),
        ['user', 'system', 'developer'],
      );
    });

    test('name is carried onto the start, and absent when not sent', () async {
      final named = await _expand([_text(id: 'm', name: 'Ada', delta: 'a')]);
      expect(named.first['name'], 'Ada');
      final unnamed = await _expand([_text(id: 'm', delta: 'a')]);
      expect(unnamed.first.containsKey('name'), isFalse);
    });

    test('the name is not repeated on content events', () async {
      final out = await _expand([_text(id: 'm', name: 'Ada', delta: 'a')]);
      expect(out.last.containsKey('name'), isFalse);
    });
  });

  group('opener agreement', () {
    test('rejects a role conflicting with the explicit opener role', () {
      return _expectFatal([
        _text(id: 'm', role: 'user', delta: 'a'),
        _text(role: 'assistant', delta: 'b'),
      ], "does not match the open stream's role");
    });

    test('rejects a role conflicting with the defaulted assistant role', () {
      return _expectFatal(
        [_text(id: 'm', delta: 'a'), _text(id: 'm', role: 'user', delta: 'b')],
        "Cannot continue text message 'm': chunk role 'user' does not match "
        "the open stream's role 'assistant'.",
      );
    });

    test('rejects a name the opener did not carry', () {
      return _expectFatal([
        _text(id: 'm', delta: 'a'),
        _text(name: 'Ada', delta: 'b'),
      ], "chunk name 'Ada' does not match the open stream's name (absent).");
    });

    test('rejects a conflicting toolCallName', () {
      return _expectFatal(
        [_tool(id: 't', name: 'search'), _tool(name: 'other', delta: '{}')],
        "Cannot continue tool call 't': chunk toolCallName 'other' does not "
        "match the open stream's toolCallName 'search'.",
      );
    });

    test('rejects a conflicting parentMessageId', () {
      return _expectFatal([
        _tool(id: 't', name: 'search', parent: 'p1'),
        _tool(id: 't', parent: 'p2', delta: '{}'),
      ], "does not match the open stream's parentMessageId 'p1'");
    });

    test('accepts repeats with identical values', () async {
      expect(
        await _types([
          _text(id: 'm', role: 'user', name: 'Ada', delta: 'a'),
          _text(id: 'm', role: 'user', name: 'Ada', delta: 'b'),
          _tool(id: 't', name: 'f', parent: 'p'),
          _tool(id: 't', name: 'f', parent: 'p', delta: '{}'),
        ]),
        [
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_CONTENT',
          'TEXT_MESSAGE_CONTENT',
          'TEXT_MESSAGE_END',
          'TOOL_CALL_START',
          'TOOL_CALL_ARGS',
        ],
      );
    });

    test('accepts a repeat of the defaulted assistant role', () async {
      expect(
        await _types([
          _text(id: 'm', delta: 'a'),
          _text(role: 'assistant', delta: 'b'),
        ]),
        ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CONTENT'],
      );
    });

    test(
      'a chunk opening a new message is not a conflicting continuation',
      () async {
        final out = await _expand([
          _text(id: 'm1', role: 'user', delta: 'a'),
          _text(id: 'm2', role: 'assistant', delta: 'b'),
        ]);
        expect(out.map((e) => '${e['type']}:${e['messageId']}'), [
          'TEXT_MESSAGE_START:m1',
          'TEXT_MESSAGE_CONTENT:m1',
          'TEXT_MESSAGE_END:m1',
          'TEXT_MESSAGE_START:m2',
          'TEXT_MESSAGE_CONTENT:m2',
        ]);
      },
    );
  });

  group('first chunk requirements', () {
    test('a first text chunk without messageId is fatal', () {
      return _expectFatal([
        _text(delta: 'a'),
      ], 'First TEXT_MESSAGE_CHUNK must have a messageId');
    });

    test('a first tool chunk without toolCallId is fatal', () {
      return _expectFatal([
        _tool(name: 'f'),
      ], 'First TOOL_CALL_CHUNK must have a toolCallId');
    });

    test('a first tool chunk without toolCallName is fatal', () {
      return _expectFatal([
        _tool(id: 't', delta: '{}'),
      ], 'First TOOL_CALL_CHUNK must have a toolCallName');
    });

    test('a first reasoning chunk without messageId is fatal', () {
      return _expectFatal([
        _reasoning(delta: 'a'),
      ], 'First REASONING_MESSAGE_CHUNK must have a messageId');
    });

    test('an id-less text chunk after a closed message is fatal', () {
      return _expectFatal([
        _text(id: 'm', delta: 'a'),
        {'type': 'STEP_STARTED', 'stepName': 's'},
        _text(delta: 'b'),
      ], 'First TEXT_MESSAGE_CHUNK must have a messageId');
    });

    test('events before the fatal chunk are still delivered', () async {
      Object? error;
      final seen =
          await transformChunks(
            _source([_text(id: 'm', delta: 'a'), _tool(delta: 'x')]),
          ).handleError((Object e) => error = e).map((e) => e.type).toList();
      expect(seen, [EventType.textMessageStart, EventType.textMessageContent]);
      expect(error, isA<AguiProtocolException>());
    });
  });

  group('closing', () {
    test(
      'switching from text to a tool call closes the text message',
      () async {
        expect(
          await _types([
            _text(id: 'm', delta: 'a'),
            _tool(id: 't', name: 'f', delta: '{}'),
            _runFinished,
          ]),
          [
            'TEXT_MESSAGE_START',
            'TEXT_MESSAGE_CONTENT',
            'TEXT_MESSAGE_END',
            'TOOL_CALL_START',
            'TOOL_CALL_ARGS',
            'TOOL_CALL_END',
            'RUN_FINISHED',
          ],
        );
      },
    );

    test(
      'switching from text to reasoning in one lane closes the text',
      () async {
        expect(
          await _types([
            _text(id: 'm', delta: 'a'),
            _reasoning(id: 'r', delta: 'b'),
          ]),
          [
            'TEXT_MESSAGE_START',
            'TEXT_MESSAGE_CONTENT',
            'TEXT_MESSAGE_END',
            'REASONING_MESSAGE_START',
            'REASONING_MESSAGE_CONTENT',
          ],
        );
      },
    );

    test('a non-chunk, non-RAW event closes the open lane first', () async {
      const snapshot = {
        'type': 'STATE_SNAPSHOT',
        'snapshot': <String, Object?>{},
      };
      expect(await _expand([_text(id: 'm', delta: 'a'), snapshot]), [
        {'type': 'TEXT_MESSAGE_START', 'messageId': 'm', 'role': 'assistant'},
        {'type': 'TEXT_MESSAGE_CONTENT', 'messageId': 'm', 'delta': 'a'},
        {'type': 'TEXT_MESSAGE_END', 'messageId': 'm'},
        snapshot,
      ]);
    });

    test('each explicit lifecycle event closes the parent lane', () async {
      final closers = <Json>[
        {'type': 'TEXT_MESSAGE_START', 'messageId': 'x'},
        {'type': 'TOOL_CALL_START', 'toolCallId': 'x', 'toolCallName': 'f'},
        {
          'type': 'TOOL_CALL_RESULT',
          'messageId': 'x',
          'toolCallId': 'x',
          'content': 'c',
        },
        {'type': 'STATE_DELTA', 'delta': <Object?>[]},
        {'type': 'STEP_STARTED', 'stepName': 's'},
        {'type': 'STEP_FINISHED', 'stepName': 's'},
        {'type': 'REASONING_START', 'messageId': 'x'},
        {'type': 'REASONING_END', 'messageId': 'x'},
        {'type': 'CUSTOM', 'name': 'n', 'value': 1},
        {'type': 'MESSAGES_SNAPSHOT', 'messages': <Object?>[]},
        {'type': 'RUN_ERROR', 'message': 'boom'},
        _runStarted,
      ];
      for (final closer in closers) {
        expect(await _types([_text(id: 'm', delta: 'a'), closer]), [
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_CONTENT',
          'TEXT_MESSAGE_END',
          closer['type'],
        ], reason: '${closer['type']}');
      }
    });

    test('RAW does not close the open lane', () async {
      const raw = {
        'type': 'RAW',
        'event': {'provider': 'x'},
      };
      expect(
        await _expand([_text(id: 'm', delta: 'a'), raw, _text(delta: 'b')]),
        [
          {'type': 'TEXT_MESSAGE_START', 'messageId': 'm', 'role': 'assistant'},
          {'type': 'TEXT_MESSAGE_CONTENT', 'messageId': 'm', 'delta': 'a'},
          raw,
          {'type': 'TEXT_MESSAGE_CONTENT', 'messageId': 'm', 'delta': 'b'},
        ],
      );
    });

    test(
      'activity, encrypted value and SUBAGENT_STARTED do not close it',
      () async {
        final passthrough = <Json>[
          {
            'type': 'ACTIVITY_SNAPSHOT',
            'messageId': 'a',
            'activityType': 'x',
            'content': <String, Object?>{},
          },
          {
            'type': 'REASONING_ENCRYPTED_VALUE',
            'subtype': 'message',
            'entityId': 'e',
            'encryptedValue': 'v',
          },
          {'type': 'SUBAGENT_STARTED', 'subagentRunId': 's', 'name': 'n'},
        ];
        for (final event in passthrough) {
          expect(
            await _types([
              _text(id: 'm', delta: 'a'),
              event,
              _text(delta: 'b'),
            ]),
            [
              'TEXT_MESSAGE_START',
              'TEXT_MESSAGE_CONTENT',
              event['type'],
              'TEXT_MESSAGE_CONTENT',
            ],
            reason: '${event['type']}',
          );
        }
      },
    );

    test('CUSTOM closes the open lane', () async {
      expect(
        await _types([
          _text(id: 'm', delta: 'a'),
          {'type': 'CUSTOM', 'name': 'n', 'value': 1},
        ]),
        [
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_CONTENT',
          'TEXT_MESSAGE_END',
          'CUSTOM',
        ],
      );
    });

    test('stream completion closes nothing', () async {
      expect(
        await _types([
          _text(id: 'm', delta: 'a'),
          _tool(id: 't', name: 'f', sub: 's1'),
        ]),
        ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TOOL_CALL_START'],
      );
    });

    test('non-chunk events pass through unchanged', () async {
      const custom = {'type': 'CUSTOM', 'name': 'n', 'value': 1};
      expect(await _expand([_runStarted, custom, _runFinished]), [
        _runStarted,
        custom,
        _runFinished,
      ]);
    });
  });

  group('attribution on synthesized events', () {
    test('subagentRunId is carried onto every synthesized opener', () async {
      final out = await _expand([
        _text(id: 'm', sub: 's1', delta: 'a'),
        _tool(id: 't', name: 'f', sub: 's2'),
        _reasoning(id: 'r', sub: 's3'),
      ]);
      expect(
        {
          for (final e in out)
            if ((e['type']! as String).endsWith('_START'))
              e['type']: e['subagentRunId'],
        },
        {
          'TEXT_MESSAGE_START': 's1',
          'TOOL_CALL_START': 's2',
          'REASONING_MESSAGE_START': 's3',
        },
      );
    });

    test("the synthesized END carries the opener's subagentRunId", () async {
      final out = await _expand([
        _text(id: 'm', sub: 's1', delta: 'a'),
        {'type': 'SUBAGENT_FINISHED', 'subagentRunId': 's1'},
      ]);
      expect(out[2], {
        'type': 'TEXT_MESSAGE_END',
        'subagentRunId': 's1',
        'messageId': 'm',
      });
    });

    test("an untagged continuation inherits the opener's tag", () async {
      final out = await _expand([
        _text(id: 'm', sub: 's1', delta: 'a'),
        _text(delta: 'b'),
      ]);
      expect(out.last['subagentRunId'], 's1');
    });

    test('an untagged stream synthesizes untagged events', () async {
      final out = await _expand([_text(id: 'm', delta: 'a'), _runFinished]);
      expect(out.any((e) => e.containsKey('subagentRunId')), isFalse);
    });
  });

  group('metadata and rawEvent', () {
    const meta = {'usage': 3};

    test("a chunk's metadata is stamped on start and content", () async {
      for (final chunk in [
        _text(id: 'm', delta: 'a', metadata: meta),
        _tool(id: 't', name: 'f', delta: '{}', metadata: meta),
        _reasoning(id: 'r', delta: 'a', metadata: meta),
      ]) {
        final out = await _expand([chunk]);
        expect(out.map((e) => e['metadata']), [meta, meta]);
      }
    });

    test('metadata stays absent when the chunk carries none', () async {
      final out = await _expand([_text(id: 'm', delta: 'a'), _runFinished]);
      expect(out.any((e) => e.containsKey('metadata')), isFalse);
    });

    test(
      "the new chunk's metadata does not leak onto the previous END",
      () async {
        final out = await _expand([
          _text(id: 'm1', delta: 'a'),
          _tool(id: 't', name: 'f', metadata: meta),
        ]);
        expect(out[2], {'type': 'TEXT_MESSAGE_END', 'messageId': 'm1'});
        expect(out[3]['metadata'], meta);
      },
    );

    test(
      'a metadata-only continuation becomes a zero-delta content event',
      () async {
        expect(
          (await _expand([
            _text(id: 'm', delta: 'a'),
            _text(metadata: meta),
          ])).last,
          {
            'type': 'TEXT_MESSAGE_CONTENT',
            'metadata': meta,
            'messageId': 'm',
            'delta': '',
          },
        );
        expect(
          (await _expand([
            _tool(id: 't', name: 'f'),
            _tool(metadata: meta),
          ])).last,
          {
            'type': 'TOOL_CALL_ARGS',
            'metadata': meta,
            'toolCallId': 't',
            'delta': '',
          },
        );
        expect(
          (await _expand([
            _reasoning(id: 'r'),
            _reasoning(metadata: meta),
          ])).last,
          {
            'type': 'REASONING_MESSAGE_CONTENT',
            'metadata': meta,
            'messageId': 'r',
            'delta': '',
          },
        );
      },
    );

    test('a metadata-only continuation keeps the lane attribution', () async {
      final out = await _expand([
        _text(id: 'm', sub: 's1', delta: 'a'),
        _text(metadata: meta),
      ]);
      expect(out.last['subagentRunId'], 's1');
    });

    test('a metadata-only opener emits no content event', () async {
      expect(await _types([_text(id: 'm', metadata: meta)]), [
        'TEXT_MESSAGE_START',
      ]);
    });

    test('rawEvent rides the content event, not the opener', () async {
      final out = await _expand([
        _text(id: 'm', delta: 'a', raw: {'p': 1}),
      ]);
      expect(out.first.containsKey('rawEvent'), isFalse);
      expect(out.last['rawEvent'], {'p': 1});
    });

    test(
      "a first chunk's rawEvent is carried on a zero-delta content",
      () async {
        final out = await _expand([_tool(id: 't', name: 'f', raw: 'payload')]);
        expect(out, [
          {'type': 'TOOL_CALL_START', 'toolCallId': 't', 'toolCallName': 'f'},
          {
            'type': 'TOOL_CALL_ARGS',
            'rawEvent': 'payload',
            'toolCallId': 't',
            'delta': '',
          },
        ]);
      },
    );

    test('a rawEvent-only continuation is carried', () async {
      final out = await _expand([
        _reasoning(id: 'r', delta: 'a'),
        _reasoning(raw: 7),
      ]);
      expect(out.last, {
        'type': 'REASONING_MESSAGE_CONTENT',
        'rawEvent': 7,
        'messageId': 'r',
        'delta': '',
      });
    });
  });

  group('lanes', () {
    test(
      "interleaved subagents' text messages stay open independently",
      () async {
        final out = await _expand([
          _text(id: 'a', sub: 's1', delta: '1'),
          _text(id: 'b', sub: 's2', delta: '2'),
          _text(sub: 's1', delta: '3'),
          _text(sub: 's2', delta: '4'),
          _runFinished,
        ]);
        expect(
          out.map(
            (e) => '${e['type']}:${e['messageId']}:${e['subagentRunId']}',
          ),
          [
            'TEXT_MESSAGE_START:a:s1',
            'TEXT_MESSAGE_CONTENT:a:s1',
            'TEXT_MESSAGE_START:b:s2',
            'TEXT_MESSAGE_CONTENT:b:s2',
            'TEXT_MESSAGE_CONTENT:a:s1',
            'TEXT_MESSAGE_CONTENT:b:s2',
            'TEXT_MESSAGE_END:a:s1',
            'TEXT_MESSAGE_END:b:s2',
            'RUN_FINISHED:null:null',
          ],
        );
      },
    );

    test("one subagent's tool chunk does not close another's text", () async {
      expect(
        await _types([
          _text(id: 'a', sub: 's1', delta: '1'),
          _tool(id: 't', name: 'f', sub: 's2'),
          _text(sub: 's1', delta: '2'),
        ]),
        [
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_CONTENT',
          'TOOL_CALL_START',
          'TEXT_MESSAGE_CONTENT',
        ],
      );
    });

    test(
      'the sole open stream is continued by an untagged id-less chunk',
      () async {
        final out = await _expand([
          _text(id: 'a', sub: 's1', delta: '1'),
          _text(delta: '2'),
        ]);
        expect(out.last['messageId'], 'a');
        expect(out.last['subagentRunId'], 's1');
      },
    );

    test('an untagged continuation prefers the parent lane', () async {
      final out = await _expand([
        _text(id: 'p', delta: '1'),
        _text(id: 'a', sub: 's1', delta: '2'),
        _text(delta: '3'),
      ]);
      expect(out.last, {
        'type': 'TEXT_MESSAGE_CONTENT',
        'messageId': 'p',
        'delta': '3',
      });
    });

    test(
      'continues the sole subagent text stream when the parent has another kind open',
      () async {
        final out = await _expand([
          _tool(id: 't', name: 'f'),
          _text(id: 'a', sub: 's1', delta: '1'),
          _text(delta: '2'),
        ]);
        expect(out.last['messageId'], 'a');
        expect(out.map((e) => e['type']), isNot(contains('TOOL_CALL_END')));
      },
    );

    test('an untagged chunk naming an id continues it in its lane', () async {
      final out = await _expand([
        _text(id: 'a', sub: 's1', delta: '1'),
        _text(id: 'b', sub: 's2', delta: '2'),
        _text(id: 'a', delta: '3'),
      ]);
      expect(out.last['messageId'], 'a');
      expect(out.last['subagentRunId'], 's1');
    });

    test(
      'ambiguous id-less untagged chunks are fatal for every kind',
      () async {
        await _expectFatal(
          [
            _text(id: 'a', sub: 's1', delta: '1'),
            _text(id: 'b', sub: 's2', delta: '2'),
            _text(delta: '3'),
          ],
          'Ambiguous TEXT_MESSAGE_CHUNK: it carries neither a messageId nor a '
          'subagentRunId, but 2 lanes have an open text message.',
        );
        await _expectFatal([
          _tool(id: 'a', name: 'f', sub: 's1'),
          _tool(id: 'b', name: 'f', sub: 's2'),
          _tool(delta: '{}'),
        ], 'Ambiguous TOOL_CALL_CHUNK: it carries neither a toolCallId');
        await _expectFatal([
          _reasoning(id: 'a', sub: 's1'),
          _reasoning(id: 'b', sub: 's2'),
          _reasoning(delta: 'x'),
        ], 'Ambiguous REASONING_MESSAGE_CHUNK');
      },
    );

    test('a tag disagreeing with the lane holding the id is fatal', () async {
      await _expectFatal(
        [_text(id: 'a', sub: 's1', delta: '1'), _text(id: 'a', sub: 's2')],
        "Cannot continue text message 'a': chunk subagentRunId 's2' does not "
        "match the open stream's subagent 's1'.",
      );
      await _expectFatal([
        _tool(id: 't', name: 'f', sub: 's1'),
        _tool(id: 't', sub: 's2', delta: '{}'),
      ], "Cannot continue tool call 't'");
      await _expectFatal([
        _reasoning(id: 'r', sub: 's1'),
        _reasoning(id: 'r', sub: 's2'),
      ], "Cannot continue reasoning message 'r'");
    });

    test("a subagent-tagged chunk cannot continue the parent's stream", () {
      return _expectFatal([
        _text(id: 'p', delta: '1'),
        _text(id: 'p', sub: 's1', delta: '2'),
      ], "does not match the open stream's subagent '(the parent agent)'.");
    });

    test('a new id in the same lane closes the previous stream', () async {
      final out = await _expand([
        _text(id: 'a', sub: 's1', delta: '1'),
        _text(id: 'b', sub: 's1', delta: '2'),
      ]);
      expect(out[2], {
        'type': 'TEXT_MESSAGE_END',
        'subagentRunId': 's1',
        'messageId': 'a',
      });
    });

    test('an explicitly empty reasoning id opens a new stream', () async {
      final out = await _expand([
        _reasoning(id: 'r', delta: '1'),
        _reasoning(id: '', delta: '2'),
      ]);
      expect(out.map((e) => '${e['type']}:${e['messageId']}'), [
        'REASONING_MESSAGE_START:r',
        'REASONING_MESSAGE_CONTENT:r',
        'REASONING_MESSAGE_END:r',
        'REASONING_MESSAGE_START:',
        'REASONING_MESSAGE_CONTENT:',
      ]);
    });

    test(
      "SUBAGENT_FINISHED and SUBAGENT_ERROR close only their own lane",
      () async {
        final out = await _expand([
          _text(id: 'p', delta: '0'),
          _text(id: 'a', sub: 's1', delta: '1'),
          _tool(id: 't', name: 'f', sub: 's2'),
          {'type': 'SUBAGENT_FINISHED', 'subagentRunId': 's1'},
          {'type': 'SUBAGENT_ERROR', 'subagentRunId': 's2', 'message': 'x'},
          _text(delta: 'still open'),
        ]);
        expect(out.skip(5).map((e) => e['type']), [
          'TEXT_MESSAGE_END',
          'SUBAGENT_FINISHED',
          'TOOL_CALL_END',
          'SUBAGENT_ERROR',
          'TEXT_MESSAGE_CONTENT',
        ]);
        expect(out.last['messageId'], 'p');
      },
    );

    test(
      'a terminal for a subagent with nothing open emits just itself',
      () async {
        const fin = {'type': 'SUBAGENT_FINISHED', 'subagentRunId': 's9'};
        expect(await _expand([fin]), [fin]);
      },
    );

    test(
      'run-level events close every lane in the order they opened',
      () async {
        for (final terminal in <Json>[
          _runFinished,
          {'type': 'RUN_ERROR', 'message': 'x'},
          {'type': 'MESSAGES_SNAPSHOT', 'messages': <Object?>[]},
          _runStarted,
        ]) {
          final out = await _expand([
            _text(id: 'b', sub: 's2', delta: '1'),
            _tool(id: 't', name: 'f'),
            _reasoning(id: 'a', sub: 's1'),
            terminal,
          ]);
          expect(out.skip(4).map((e) => '${e['type']}:${e['subagentRunId']}'), [
            'TEXT_MESSAGE_END:s2',
            'TOOL_CALL_END:null',
            'REASONING_MESSAGE_END:s1',
            '${terminal['type']}:null',
          ], reason: '${terminal['type']}');
        }
      },
    );

    test(
      "the parent's explicit message does not close a subagent's stream",
      () async {
        expect(
          await _types([
            _text(id: 'a', sub: 's1', delta: '1'),
            {'type': 'TEXT_MESSAGE_START', 'messageId': 'p'},
            _text(delta: '2'),
          ]),
          [
            'TEXT_MESSAGE_START',
            'TEXT_MESSAGE_CONTENT',
            'TEXT_MESSAGE_START',
            'TEXT_MESSAGE_CONTENT',
          ],
        );
      },
    );

    test("a subagent's own explicit event closes its stream", () async {
      expect(
        await _types([
          _text(id: 'a', sub: 's1', delta: '1'),
          {'type': 'STEP_STARTED', 'stepName': 'x', 'subagentRunId': 's1'},
        ]),
        [
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_CONTENT',
          'TEXT_MESSAGE_END',
          'STEP_STARTED',
        ],
      );
    });

    test("a subagent's step does not close the parent's stream", () async {
      expect(
        await _types([
          _text(id: 'p', delta: '1'),
          {'type': 'STEP_STARTED', 'stepName': 'x', 'subagentRunId': 's1'},
          _text(delta: '2'),
        ]),
        [
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_CONTENT',
          'STEP_STARTED',
          'TEXT_MESSAGE_CONTENT',
        ],
      );
    });

    test('lanes reopen in a second run', () async {
      expect(
        await _types([
          _runStarted,
          _text(id: 'a', delta: '1'),
          _runFinished,
          _runStarted,
          _text(id: 'b', delta: '2'),
          _runFinished,
        ]),
        [
          'RUN_STARTED',
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_CONTENT',
          'TEXT_MESSAGE_END',
          'RUN_FINISHED',
          'RUN_STARTED',
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_CONTENT',
          'TEXT_MESSAGE_END',
          'RUN_FINISHED',
        ],
      );
    });
  });
}
