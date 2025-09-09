import 'dart:convert';
import 'dart:typed_data';

import 'package:ag_ui/src/encoder/decoder.dart';
import 'package:ag_ui/src/encoder/errors.dart';
import 'package:ag_ui/src/events/events.dart';
import 'package:ag_ui/src/types/base.dart';
import 'package:ag_ui/src/types/message.dart';
import 'package:test/test.dart';

void main() {
  group('EventDecoder', () {
    late EventDecoder decoder;

    setUp(() {
      decoder = const EventDecoder();
    });

    group('decode', () {
      test('decodes simple text message start event', () {
        final json = '{"type":"TEXT_MESSAGE_START","messageId":"msg123","role":"assistant"}';
        final event = decoder.decode(json);
        
        expect(event, isA<TextMessageStartEvent>());
        final textEvent = event as TextMessageStartEvent;
        expect(textEvent.messageId, equals('msg123'));
        expect(textEvent.role, equals(TextMessageRole.assistant));
      });

      test('decodes text message content event', () {
        final json = '{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg123","delta":"Hello, world!"}';
        final event = decoder.decode(json);
        
        expect(event, isA<TextMessageContentEvent>());
        final textEvent = event as TextMessageContentEvent;
        expect(textEvent.messageId, equals('msg123'));
        expect(textEvent.delta, equals('Hello, world!'));
      });

      test('decodes tool call events', () {
        final json = '{"type":"TOOL_CALL_START","toolCallId":"tool456","toolCallName":"search"}';
        final event = decoder.decode(json);
        
        expect(event, isA<ToolCallStartEvent>());
        final toolEvent = event as ToolCallStartEvent;
        expect(toolEvent.toolCallId, equals('tool456'));
        expect(toolEvent.toolCallName, equals('search'));
      });

      test('throws DecodeError for invalid JSON', () {
        final invalidJson = 'not valid json';
        
        expect(
          () => decoder.decode(invalidJson),
          throwsA(isA<DecodeError>()
            .having((e) => e.message, 'message', contains('Invalid JSON'))
            .having((e) => e.source, 'source', equals(invalidJson))),
        );
      });

      test('throws AGUIValidationError for missing required fields', () {
        final json = '{"type":"TEXT_MESSAGE_START"}'; // Missing messageId
        
        expect(
          () => decoder.decode(json),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('throws AGUIValidationError for empty delta in content event', () {
        final json = '{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg123","delta":""}';
        
        expect(
          () => decoder.decode(json),
          throwsA(isA<AGUIValidationError>()
            .having((e) => e.message, 'message', contains('Delta must not be an empty string'))),
        );
      });
    });

    group('decodeJson', () {
      test('decodes from Map<String, dynamic>', () {
        final json = {
          'type': 'RUN_STARTED',
          'threadId': 'thread789',
          'runId': 'run012',
        };
        
        final event = decoder.decodeJson(json);
        
        expect(event, isA<RunStartedEvent>());
        final runEvent = event as RunStartedEvent;
        expect(runEvent.threadId, equals('thread789'));
        expect(runEvent.runId, equals('run012'));
      });

      test('handles snake_case field names', () {
        final json = {
          'type': 'RUN_STARTED',
          'thread_id': 'thread789',
          'run_id': 'run012',
        };
        
        final event = decoder.decodeJson(json);
        
        expect(event, isA<RunStartedEvent>());
        final runEvent = event as RunStartedEvent;
        expect(runEvent.threadId, equals('thread789'));
        expect(runEvent.runId, equals('run012'));
      });

      test('decodes state snapshot with complex nested data', () {
        final json = {
          'type': 'STATE_SNAPSHOT',
          'snapshot': {
            'user': {
              'id': 123,
              'name': 'Alice',
              'tags': ['admin', 'developer'],
            },
            'settings': {
              'theme': 'dark',
              'notifications': true,
            },
          },
        };
        
        final event = decoder.decodeJson(json);
        
        expect(event, isA<StateSnapshotEvent>());
        final stateEvent = event as StateSnapshotEvent;
        expect(stateEvent.snapshot, isA<Map>());
        expect(stateEvent.snapshot['user']['name'], equals('Alice'));
        expect(stateEvent.snapshot['settings']['theme'], equals('dark'));
      });

      test('decodes messages snapshot', () {
        final json = {
          'type': 'MESSAGES_SNAPSHOT',
          'messages': [
            {
              'role': 'user',
              'content': 'Hello',
            },
            {
              'role': 'assistant',
              'content': 'Hi there!',
            },
          ],
        };
        
        final event = decoder.decodeJson(json);
        
        expect(event, isA<MessagesSnapshotEvent>());
        final messagesEvent = event as MessagesSnapshotEvent;
        expect(messagesEvent.messages.length, equals(2));
        expect(messagesEvent.messages[0].role, equals(MessageRole.user));
        expect(messagesEvent.messages[0].content, equals('Hello'));
        expect(messagesEvent.messages[1].role, equals(MessageRole.assistant));
        expect(messagesEvent.messages[1].content, equals('Hi there!'));
      });

      test('preserves optional fields when present', () {
        final json = {
          'type': 'TOOL_CALL_START',
          'toolCallId': 'tool456',
          'toolCallName': 'search',
          'parentMessageId': 'msg123',
          'timestamp': 1234567890,
        };
        
        final event = decoder.decodeJson(json);
        
        expect(event, isA<ToolCallStartEvent>());
        final toolEvent = event as ToolCallStartEvent;
        expect(toolEvent.parentMessageId, equals('msg123'));
        expect(toolEvent.timestamp, equals(1234567890));
      });

      test('handles optional fields being null', () {
        final json = {
          'type': 'TEXT_MESSAGE_CHUNK',
          'messageId': 'msg123',
        };
        
        final event = decoder.decodeJson(json);
        
        expect(event, isA<TextMessageChunkEvent>());
        final chunkEvent = event as TextMessageChunkEvent;
        expect(chunkEvent.messageId, equals('msg123'));
        expect(chunkEvent.role, isNull);
        expect(chunkEvent.delta, isNull);
      });
    });

    group('decodeSSE', () {
      test('decodes complete SSE message', () {
        final sseMessage = 'data: {"type":"TEXT_MESSAGE_START","messageId":"msg123"}\n\n';
        final event = decoder.decodeSSE(sseMessage);
        
        expect(event, isA<TextMessageStartEvent>());
        final textEvent = event as TextMessageStartEvent;
        expect(textEvent.messageId, equals('msg123'));
      });

      test('decodes SSE message without space after colon', () {
        final sseMessage = 'data:{"type":"TEXT_MESSAGE_END","messageId":"msg123"}\n\n';
        final event = decoder.decodeSSE(sseMessage);
        
        expect(event, isA<TextMessageEndEvent>());
        final textEvent = event as TextMessageEndEvent;
        expect(textEvent.messageId, equals('msg123'));
      });

      test('handles multi-line data fields', () {
        final sseMessage = '''data: {"type":"TEXT_MESSAGE_CONTENT",
data: "messageId":"msg123",
data: "delta":"Hello"}

''';
        final event = decoder.decodeSSE(sseMessage);
        
        expect(event, isA<TextMessageContentEvent>());
        final textEvent = event as TextMessageContentEvent;
        expect(textEvent.messageId, equals('msg123'));
        expect(textEvent.delta, equals('Hello'));
      });

      test('ignores non-data fields', () {
        final sseMessage = '''id: 123
event: message
retry: 1000
data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}

''';
        final event = decoder.decodeSSE(sseMessage);
        
        expect(event, isA<RunFinishedEvent>());
        final runEvent = event as RunFinishedEvent;
        expect(runEvent.threadId, equals('t1'));
        expect(runEvent.runId, equals('r1'));
      });

      test('throws DecodeError for SSE without data field', () {
        final sseMessage = 'id: 123\nevent: message\n\n';
        
        expect(
          () => decoder.decodeSSE(sseMessage),
          throwsA(isA<DecodeError>()
            .having((e) => e.message, 'message', contains('No data found'))),
        );
      });

      test('throws DecodeError for SSE keep-alive comment', () {
        final sseMessage = 'data: :\n\n';
        
        expect(
          () => decoder.decodeSSE(sseMessage),
          throwsA(isA<DecodeError>()
            .having((e) => e.message, 'message', contains('keep-alive'))),
        );
      });
    });

    group('decodeBinary', () {
      test('decodes UTF-8 encoded JSON', () {
        final json = '{"type":"CUSTOM","name":"test","value":42}';
        final binary = Uint8List.fromList(utf8.encode(json));
        
        final event = decoder.decodeBinary(binary);
        
        expect(event, isA<CustomEvent>());
        final customEvent = event as CustomEvent;
        expect(customEvent.name, equals('test'));
        expect(customEvent.value, equals(42));
      });

      test('decodes UTF-8 encoded SSE message', () {
        final sseMessage = 'data: {"type":"RAW","event":{"foo":"bar"}}\n\n';
        final binary = Uint8List.fromList(utf8.encode(sseMessage));
        
        final event = decoder.decodeBinary(binary);
        
        expect(event, isA<RawEvent>());
        final rawEvent = event as RawEvent;
        expect(rawEvent.event, equals({'foo': 'bar'}));
      });

      test('throws DecodeError for invalid UTF-8', () {
        // Invalid UTF-8 sequence
        final binary = Uint8List.fromList([0xFF, 0xFE, 0xFD]);
        
        expect(
          () => decoder.decodeBinary(binary),
          throwsA(isA<DecodeError>()
            .having((e) => e.message, 'message', contains('Invalid UTF-8'))),
        );
      });
    });

    group('validate', () {
      test('validates text message start event', () {
        final event = TextMessageStartEvent(messageId: 'msg123');
        expect(decoder.validate(event), isTrue);
      });

      test('throws ValidationError for empty messageId', () {
        final event = TextMessageStartEvent(messageId: '');
        
        expect(
          () => decoder.validate(event),
          throwsA(isA<ValidationError>()
            .having((e) => e.field, 'field', equals('messageId'))
            .having((e) => e.message, 'message', contains('cannot be empty'))),
        );
      });

      test('throws ValidationError for empty delta in content event', () {
        final event = TextMessageContentEvent(
          messageId: 'msg123',
          delta: '',
        );
        
        expect(
          () => decoder.validate(event),
          throwsA(isA<ValidationError>()
            .having((e) => e.field, 'field', equals('delta'))
            .having((e) => e.message, 'message', contains('cannot be empty'))),
        );
      });

      test('throws ValidationError for empty tool call fields', () {
        final event = ToolCallStartEvent(
          toolCallId: '',
          toolCallName: 'search',
        );
        
        expect(
          () => decoder.validate(event),
          throwsA(isA<ValidationError>()
            .having((e) => e.field, 'field', equals('toolCallId'))),
        );
      });

      test('throws ValidationError for empty run fields', () {
        final event = RunStartedEvent(
          threadId: 'thread123',
          runId: '',
        );
        
        expect(
          () => decoder.validate(event),
          throwsA(isA<ValidationError>()
            .having((e) => e.field, 'field', equals('runId'))),
        );
      });

      test('validates events without specific validation rules', () {
        final event = ThinkingStartEvent(title: 'Planning');
        expect(decoder.validate(event), isTrue);
        
        final event2 = StateSnapshotEvent(snapshot: {});
        expect(decoder.validate(event2), isTrue);
        
        final event3 = CustomEvent(name: 'test', value: null);
        expect(decoder.validate(event3), isTrue);
      });
    });

    group('error handling', () {
      test('preserves stack trace on decode errors', () {
        final invalidJson = 'not json';
        
        try {
          decoder.decode(invalidJson);
          fail('Should have thrown');
        } catch (e, stack) {
          expect(e, isA<DecodeError>());
          expect(stack.toString(), isNotEmpty);
        }
      });

      test('includes source in error for debugging', () {
        final json = '{"type":"UNKNOWN_EVENT"}';
        
        try {
          decoder.decode(json);
          fail('Should have thrown');
        } catch (e) {
          expect(e, isA<DecodeError>());
          final error = e as DecodeError;
          expect(error.source, equals(json));
        }
      });

      test('truncates long source in error toString', () {
        final longJson = '{"data":"${'x' * 300}"}';
        
        try {
          decoder.decode(longJson);
          fail('Should have thrown');
        } catch (e) {
          final error = e as DecodeError;
          final errorString = error.toString();
          expect(errorString, contains('(truncated)'));
          expect(errorString.length, lessThan(500));
        }
      });
    });
  });
}