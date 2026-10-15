import 'package:agui/agui.dart';
import 'package:test/test.dart';

void main() {
  test('decodes a minimal event through the union', () {
    final event = Event.fromJson({
      'type': 'TEXT_MESSAGE_CONTENT',
      'messageId': 'm1',
      'delta': 'hi',
    });
    expect(event, isA<TextMessageContentEvent>());
    expect((event as TextMessageContentEvent).delta, 'hi');
    expect(event.type, EventType.textMessageContent);
  });

  test(
    'toJson omits optional fields that are null and keeps required nulls',
    () {
      const event = CustomEvent(name: 'x', value: null);
      expect(event.toJson(), {'type': 'CUSTOM', 'name': 'x', 'value': null});
    },
  );

  test('accepts a whole-number double for an integer field', () {
    final event = Event.fromJson({
      'type': 'RUN_STARTED',
      'threadId': 't',
      'runId': 'r',
      'timestamp': 1.0,
    });
    expect((event as RunStartedEvent).timestamp, 1);
  });

  test('rejects null on an optional field', () {
    expect(
      () => Event.fromJson({
        'type': 'TEXT_MESSAGE_CONTENT',
        'messageId': 'm',
        'delta': 'd',
        'metadata': null,
      }),
      throwsA(
        isA<AguiDecodeException>().having((e) => e.path, 'path', '/metadata'),
      ),
    );
  });

  test('rejects an unknown discriminator', () {
    expect(
      () => Event.fromJson({'type': 'FUTURE_EVENT'}),
      throwsA(
        isA<AguiDecodeException>().having(
          (e) => e.message,
          'message',
          contains('unknown discriminator'),
        ),
      ),
    );
  });

  test('a missing required field names itself', () {
    expect(
      () => Event.fromJson({'type': 'TEXT_MESSAGE_CONTENT', 'messageId': 'm'}),
      throwsA(
        isA<AguiDecodeException>()
            .having((e) => e.path, 'path', '/delta')
            .having((e) => e.message, 'message', 'required'),
      ),
    );
  });

  test('ignores unknown keys', () {
    final event = Event.fromJson({
      'type': 'RUN_STARTED',
      'threadId': 't',
      'runId': 'r',
      'futureProp': 1,
    });
    expect(event.toJson(), {
      'type': 'RUN_STARTED',
      'threadId': 't',
      'runId': 'r',
    });
  });

  test('user message content is a string or a list of parts', () {
    final m = Message.fromJson({
      'id': 'u',
      'role': 'user',
      'content': [
        {'type': 'text', 'text': 'hi'},
      ],
    });
    expect((m as UserMessage).content, isA<List<ContentPart>>());
    expect(m.toJson()['content'], [
      {'type': 'text', 'text': 'hi'},
    ]);
    final plain = Message.fromJson({'id': 'u', 'role': 'user', 'content': 'x'});
    expect((plain as UserMessage).content, 'x');
  });

  test('an unknown enum value is a decode error naming the field', () {
    expect(
      () => Message.fromJson({'id': 'u', 'role': 'ghost', 'content': 'x'}),
      throwsA(
        isA<AguiDecodeException>().having(
          (e) => e.toString(),
          'toString',
          contains('role'),
        ),
      ),
    );
  });

  test('a wrong type reports what it received', () {
    expect(
      () => Event.fromJson({
        'type': 'RUN_FINISHED',
        'threadId': 't',
        'runId': 'r',
        'outcome': ['x'],
      }),
      throwsA(
        isA<AguiDecodeException>().having(
          (e) => e.message,
          'message',
          'expected object, received array',
        ),
      ),
    );
  });

  test('the protocol version is generated from the schema', () {
    expect(protocolVersion, '1.0');
  });
}
