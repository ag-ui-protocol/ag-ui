import 'package:agui/src/pipeline/compat/boundary.dart';
import 'package:test/test.dart';

void main() {
  late List<String> warnings;
  late CompatibilityBoundary boundary;
  setUp(() {
    warnings = [];
    boundary = CompatibilityBoundary(warnings.add);
  });

  test('reads a tabled optional null as absent, once per field per run', () {
    final a = boundary.transformEvent({
      'type': 'TOOL_CALL_START',
      'toolCallId': 'c',
      'toolCallName': 'n',
      'parentMessageId': null,
    });
    final b = boundary.transformEvent({
      'type': 'TOOL_CALL_START',
      'toolCallId': 'd',
      'toolCallName': 'n',
      'parentMessageId': null,
    });
    expect(a.containsKey('parentMessageId'), isFalse);
    expect(b.containsKey('parentMessageId'), isFalse);
    expect(
      warnings
          .where((w) => w.contains('TOOL_CALL_START.parentMessageId: null'))
          .length,
      1,
    );
  });

  test('a new run warns afresh', () {
    boundary.transformEvent({
      'type': 'RUN_FINISHED',
      'threadId': 't',
      'runId': 'r',
      'result': null,
    });
    boundary.transformEvent({
      'type': 'RUN_STARTED',
      'threadId': 't',
      'runId': 'r2',
    });
    boundary.transformEvent({
      'type': 'RUN_FINISHED',
      'threadId': 't',
      'runId': 'r2',
      'result': null,
    });
    expect(
      warnings.where((w) => w.contains('RUN_FINISHED.result: null')).length,
      2,
    );
  });

  test('leaves a null that is not in the table for the decoder', () {
    final e = boundary.transformEvent({
      'type': 'TEXT_MESSAGE_CONTENT',
      'messageId': 'm',
      'delta': 'd',
      'metadata': null,
    });
    expect(e.containsKey('metadata'), isTrue);
    expect(warnings, isEmpty);
  });

  test(
    'translates a THINKING triad into reasoning events with one minted id',
    () {
      final start = boundary.transformEvent({
        'type': 'THINKING_TEXT_MESSAGE_START',
      });
      final content = boundary.transformEvent({
        'type': 'THINKING_TEXT_MESSAGE_CONTENT',
        'delta': 'x',
      });
      final end = boundary.transformEvent({
        'type': 'THINKING_TEXT_MESSAGE_END',
      });
      expect(start['type'], 'REASONING_MESSAGE_START');
      expect(start['role'], 'reasoning');
      expect(content['messageId'], start['messageId']);
      expect(end['messageId'], start['messageId']);
      expect(
        warnings.any((w) => w.contains('THINKING_TEXT_MESSAGE_START')),
        isTrue,
      );
    },
  );

  test('a THINKING_START title is dropped with its own warning', () {
    final start = boundary.transformEvent({
      'type': 'THINKING_START',
      'title': 'Plan',
    });
    expect(start['type'], 'REASONING_START');
    expect(start.containsKey('title'), isFalse);
    expect(
      warnings.any((w) => w.contains('Dropping THINKING_START.title')),
      isTrue,
    );
  });

  test('a continuation without an opener mints an id and says so', () {
    final content = boundary.transformEvent({
      'type': 'THINKING_TEXT_MESSAGE_CONTENT',
      'delta': 'x',
    });
    expect(content['messageId'], isA<String>());
    expect(warnings.any((w) => w.contains('Minting a messageId')), isTrue);
  });

  test('upgrades a legacy binary part inside MESSAGES_SNAPSHOT', () {
    final e = boundary.transformEvent({
      'type': 'MESSAGES_SNAPSHOT',
      'messages': [
        {
          'id': 'u',
          'role': 'user',
          'content': [
            {
              'type': 'binary',
              'mimeType': 'image/png',
              'url': 'https://x/a.png',
            },
          ],
        },
      ],
    });
    final part = ((e['messages'] as List).first as Map)['content'] as List;
    expect(part.first, {
      'type': 'image',
      'source': {
        'type': 'url',
        'value': 'https://x/a.png',
        'mimeType': 'image/png',
      },
    });
    expect(warnings.any((w) => w.contains('binary input content')), isTrue);
  });

  test('normalizes nulls inside RUN_FINISHED outcome and usage entries', () {
    final e = boundary.transformEvent({
      'type': 'RUN_FINISHED',
      'threadId': 't',
      'runId': 'r',
      'outcome': {'type': 'success', 'pendingToolCallIds': null},
      'usage': [
        {'inputTokens': 1, 'outputTokens': 1, 'provider': null},
      ],
    });
    expect((e['outcome'] as Map).containsKey('pendingToolCallIds'), isFalse);
    expect(
      ((e['usage'] as List).first as Map).containsKey('provider'),
      isFalse,
    );
  });

  test('normalizes nulls inside RUN_STARTED input', () {
    final e = boundary.transformEvent({
      'type': 'RUN_STARTED',
      'threadId': 't',
      'runId': 'r',
      'input': {
        'threadId': 't',
        'runId': 'r',
        'forwardedProps': null,
        'messages': <Object?>[],
        'tools': [
          {'name': 'f', 'description': 'd', 'parameters': null},
        ],
      },
    });
    final input = e['input'] as Map;
    expect(input.containsKey('forwardedProps'), isFalse);
    expect(
      ((input['tools'] as List).first as Map).containsKey('parameters'),
      isFalse,
    );
  });

  test('upgrades a legacy binary part inside RUN_STARTED input', () {
    final e = boundary.transformEvent({
      'type': 'RUN_STARTED',
      'threadId': 't',
      'runId': 'r',
      'input': {
        'threadId': 't',
        'runId': 'r',
        'messages': [
          {
            'id': 'u',
            'role': 'user',
            'content': [
              {'type': 'binary', 'mimeType': 'audio/mp3', 'data': 'AAAA'},
            ],
          },
        ],
      },
    });
    final input = e['input'] as Map;
    expect(e.containsKey('messages'), isFalse);
    final part = ((input['messages'] as List).first as Map)['content'] as List;
    expect((part.first as Map)['type'], 'audio');
  });

  test('a modern event passes through untouched and silently', () {
    final event = {
      'type': 'TEXT_MESSAGE_CONTENT',
      'messageId': 'm',
      'delta': 'd',
    };
    expect(identical(boundary.transformEvent(event), event), isTrue);
    expect(warnings, isEmpty);
  });
}
