import 'package:ag_ui/src/events/event_type.dart';
import 'package:test/test.dart';

void main() {
  group('EventType', () {
    test('each enum has correct string value', () {
      expect(EventType.textMessageStart.value, equals('TEXT_MESSAGE_START'));
      expect(EventType.textMessageContent.value, equals('TEXT_MESSAGE_CONTENT'));
      expect(EventType.textMessageEnd.value, equals('TEXT_MESSAGE_END'));
      expect(EventType.textMessageChunk.value, equals('TEXT_MESSAGE_CHUNK'));
      expect(EventType.thinkingTextMessageStart.value, equals('THINKING_TEXT_MESSAGE_START'));
      expect(EventType.thinkingTextMessageContent.value, equals('THINKING_TEXT_MESSAGE_CONTENT'));
      expect(EventType.thinkingTextMessageEnd.value, equals('THINKING_TEXT_MESSAGE_END'));
      expect(EventType.toolCallStart.value, equals('TOOL_CALL_START'));
      expect(EventType.toolCallArgs.value, equals('TOOL_CALL_ARGS'));
      expect(EventType.toolCallEnd.value, equals('TOOL_CALL_END'));
      expect(EventType.toolCallChunk.value, equals('TOOL_CALL_CHUNK'));
      expect(EventType.toolCallResult.value, equals('TOOL_CALL_RESULT'));
      expect(EventType.thinkingStart.value, equals('THINKING_START'));
      expect(EventType.thinkingContent.value, equals('THINKING_CONTENT'));
      expect(EventType.thinkingEnd.value, equals('THINKING_END'));
      expect(EventType.stateSnapshot.value, equals('STATE_SNAPSHOT'));
      expect(EventType.stateDelta.value, equals('STATE_DELTA'));
      expect(EventType.messagesSnapshot.value, equals('MESSAGES_SNAPSHOT'));
      expect(EventType.raw.value, equals('RAW'));
      expect(EventType.custom.value, equals('CUSTOM'));
      expect(EventType.runStarted.value, equals('RUN_STARTED'));
      expect(EventType.runFinished.value, equals('RUN_FINISHED'));
      expect(EventType.runError.value, equals('RUN_ERROR'));
      expect(EventType.stepStarted.value, equals('STEP_STARTED'));
      expect(EventType.stepFinished.value, equals('STEP_FINISHED'));
    });

    test('fromString converts string to correct enum', () {
      expect(EventType.fromString('TEXT_MESSAGE_START'), equals(EventType.textMessageStart));
      expect(EventType.fromString('TEXT_MESSAGE_CONTENT'), equals(EventType.textMessageContent));
      expect(EventType.fromString('TEXT_MESSAGE_END'), equals(EventType.textMessageEnd));
      expect(EventType.fromString('TEXT_MESSAGE_CHUNK'), equals(EventType.textMessageChunk));
      expect(EventType.fromString('THINKING_TEXT_MESSAGE_START'), equals(EventType.thinkingTextMessageStart));
      expect(EventType.fromString('THINKING_TEXT_MESSAGE_CONTENT'), equals(EventType.thinkingTextMessageContent));
      expect(EventType.fromString('THINKING_TEXT_MESSAGE_END'), equals(EventType.thinkingTextMessageEnd));
      expect(EventType.fromString('TOOL_CALL_START'), equals(EventType.toolCallStart));
      expect(EventType.fromString('TOOL_CALL_ARGS'), equals(EventType.toolCallArgs));
      expect(EventType.fromString('TOOL_CALL_END'), equals(EventType.toolCallEnd));
      expect(EventType.fromString('TOOL_CALL_CHUNK'), equals(EventType.toolCallChunk));
      expect(EventType.fromString('TOOL_CALL_RESULT'), equals(EventType.toolCallResult));
      expect(EventType.fromString('THINKING_START'), equals(EventType.thinkingStart));
      expect(EventType.fromString('THINKING_CONTENT'), equals(EventType.thinkingContent));
      expect(EventType.fromString('THINKING_END'), equals(EventType.thinkingEnd));
      expect(EventType.fromString('STATE_SNAPSHOT'), equals(EventType.stateSnapshot));
      expect(EventType.fromString('STATE_DELTA'), equals(EventType.stateDelta));
      expect(EventType.fromString('MESSAGES_SNAPSHOT'), equals(EventType.messagesSnapshot));
      expect(EventType.fromString('RAW'), equals(EventType.raw));
      expect(EventType.fromString('CUSTOM'), equals(EventType.custom));
      expect(EventType.fromString('RUN_STARTED'), equals(EventType.runStarted));
      expect(EventType.fromString('RUN_FINISHED'), equals(EventType.runFinished));
      expect(EventType.fromString('RUN_ERROR'), equals(EventType.runError));
      expect(EventType.fromString('STEP_STARTED'), equals(EventType.stepStarted));
      expect(EventType.fromString('STEP_FINISHED'), equals(EventType.stepFinished));
    });

    test('fromString throws ArgumentError for invalid value', () {
      expect(
        () => EventType.fromString('INVALID_EVENT'),
        throwsA(isA<ArgumentError>().having(
          (e) => e.message,
          'message',
          contains('Invalid event type: INVALID_EVENT'),
        )),
      );
    });

    test('fromString is case sensitive', () {
      expect(
        () => EventType.fromString('text_message_start'),
        throwsA(isA<ArgumentError>()),
      );

      expect(
        () => EventType.fromString('Text_Message_Start'),
        throwsA(isA<ArgumentError>()),
      );
    });

    test('round trip conversion works', () {
      for (final eventType in EventType.values) {
        final stringValue = eventType.value;
        final converted = EventType.fromString(stringValue);
        expect(converted, equals(eventType));
      }
    });

    test('values list contains all event types', () {
      expect(EventType.values.length, equals(25));

      // Verify specific important event types are included
      expect(EventType.values, contains(EventType.textMessageStart));
      expect(EventType.values, contains(EventType.toolCallStart));
      expect(EventType.values, contains(EventType.runStarted));
      expect(EventType.values, contains(EventType.runFinished));
      expect(EventType.values, contains(EventType.stateSnapshot));
    });

    test('enum values are unique', () {
      final stringValues = EventType.values.map((e) => e.value).toSet();
      expect(stringValues.length, equals(EventType.values.length));
    });

    test('enum can be used in switch statements', () {
      final eventType = EventType.textMessageStart;
      String result;

      switch (eventType) {
        case EventType.textMessageStart:
          result = 'start';
          break;
        case EventType.textMessageEnd:
          result = 'end';
          break;
        default:
          result = 'other';
      }

      expect(result, equals('start'));
    });

    test('enum supports equality comparison', () {
      final type1 = EventType.toolCallStart;
      final type2 = EventType.toolCallStart;
      final type3 = EventType.toolCallEnd;

      expect(type1 == type2, isTrue);
      expect(type1 == type3, isFalse);
      expect(type1, equals(type2));
      expect(type1, isNot(equals(type3)));
    });

    test('enum has stable hash codes', () {
      final type1 = EventType.runStarted;
      final type2 = EventType.runStarted;
      final type3 = EventType.runFinished;

      expect(type1.hashCode, equals(type2.hashCode));
      expect(type1.hashCode, isNot(equals(type3.hashCode)));
    });

    test('enum supports index property', () {
      expect(EventType.textMessageStart.index, equals(0));
      expect(EventType.stepFinished.index, equals(EventType.values.length - 1));
    });

    test('enum name property returns correct name', () {
      expect(EventType.textMessageStart.name, equals('textMessageStart'));
      expect(EventType.toolCallStart.name, equals('toolCallStart'));
      expect(EventType.runStarted.name, equals('runStarted'));
    });

    test('fromString handles empty string', () {
      expect(
        () => EventType.fromString(''),
        throwsA(isA<ArgumentError>().having(
          (e) => e.message,
          'message',
          contains('Invalid event type: '),
        )),
      );
    });

    test('fromString handles whitespace', () {
      expect(
        () => EventType.fromString(' TEXT_MESSAGE_START '),
        throwsA(isA<ArgumentError>()),
      );
    });

    group('Event categories', () {
      test('text message events are grouped correctly', () {
        final textMessageEvents = [
          EventType.textMessageStart,
          EventType.textMessageContent,
          EventType.textMessageEnd,
          EventType.textMessageChunk,
        ];

        for (final event in textMessageEvents) {
          expect(event.value, contains('TEXT_MESSAGE'));
        }
      });

      test('thinking events are grouped correctly', () {
        final thinkingEvents = [
          EventType.thinkingStart,
          EventType.thinkingContent,
          EventType.thinkingEnd,
          EventType.thinkingTextMessageStart,
          EventType.thinkingTextMessageContent,
          EventType.thinkingTextMessageEnd,
        ];

        for (final event in thinkingEvents) {
          expect(event.value, contains('THINKING'));
        }
      });

      test('tool call events are grouped correctly', () {
        final toolEvents = [
          EventType.toolCallStart,
          EventType.toolCallArgs,
          EventType.toolCallEnd,
          EventType.toolCallChunk,
          EventType.toolCallResult,
        ];

        for (final event in toolEvents) {
          expect(event.value, contains('TOOL_CALL'));
        }
      });

      test('lifecycle events are grouped correctly', () {
        final lifecycleEvents = [
          EventType.runStarted,
          EventType.runFinished,
          EventType.runError,
          EventType.stepStarted,
          EventType.stepFinished,
        ];

        for (final event in lifecycleEvents) {
          expect(
            event.value,
            anyOf(contains('RUN'), contains('STEP')),
          );
        }
      });

      test('state events are grouped correctly', () {
        final stateEvents = [
          EventType.stateSnapshot,
          EventType.stateDelta,
          EventType.messagesSnapshot,
        ];

        for (final event in stateEvents) {
          expect(
            event.value,
            anyOf(contains('STATE'), contains('MESSAGES')),
          );
        }
      });
    });
  });
}