import 'dart:async';
import 'dart:convert';

import 'package:ag_ui/src/client/errors.dart';
import 'package:ag_ui/src/encoder/decoder.dart';
import 'package:ag_ui/src/encoder/stream_adapter.dart';
import 'package:ag_ui/src/events/events.dart';
import 'package:ag_ui/src/sse/sse_message.dart';
import 'package:ag_ui/src/types/base.dart'; // For AGUIValidationError
import 'package:ag_ui/src/types/message.dart';
import 'package:test/test.dart';

void main() {
  group('Event Decoding Integration', () {
    late EventDecoder decoder;
    late EventStreamAdapter adapter;

    setUp(() {
      decoder = const EventDecoder();
      adapter = EventStreamAdapter();
    });

    group('Python Server Events', () {
      test('decodes RUN_STARTED event from Python server format', () {
        // Python server uses snake_case
        final pythonJson = {
          'type': 'RUN_STARTED',
          'thread_id': 'thread-123',
          'run_id': 'run-456',
        };

        final event = decoder.decodeJson(pythonJson);
        expect(event, isA<RunStartedEvent>());
        
        final runEvent = event as RunStartedEvent;
        expect(runEvent.threadId, equals('thread-123'));
        expect(runEvent.runId, equals('run-456'));
      });

      test('decodes MESSAGES_SNAPSHOT with tool calls from Python server', () {
        // Example from tool_based_generative_ui.py
        final pythonJson = {
          'type': 'MESSAGES_SNAPSHOT',
          'messages': [
            {
              'id': 'msg-1',
              'role': 'user',
              'content': 'Generate a haiku',
            },
            {
              'id': 'msg-2',
              'role': 'assistant',
              'tool_calls': [
                {
                  'id': 'tool-call-1',
                  'type': 'function',
                  'function': {
                    'name': 'generate_haiku',
                    'arguments': jsonEncode({
                      'japanese': ['エーアイの', '橋つなぐ道', 'コパキット'],
                      'english': [
                        'From AI\'s realm',
                        'A bridge-road linking us—',
                        'CopilotKit.',
                      ],
                    }),
                  },
                },
              ],
            },
            {
              'id': 'msg-3',
              'role': 'tool',
              'tool_call_id': 'tool-call-1',
              'content': 'Haiku created',
            },
          ],
        };

        final event = decoder.decodeJson(pythonJson);
        expect(event, isA<MessagesSnapshotEvent>());
        
        final messagesEvent = event as MessagesSnapshotEvent;
        expect(messagesEvent.messages.length, equals(3));
        
        // Check user message
        expect(messagesEvent.messages[0].role, equals(MessageRole.user));
        expect(messagesEvent.messages[0].content, equals('Generate a haiku'));
        
        // Check assistant message with tool calls
        expect(messagesEvent.messages[1].role, equals(MessageRole.assistant));
        final assistantMsg = messagesEvent.messages[1] as AssistantMessage;
        expect(assistantMsg.toolCalls, isNotNull);
        expect(assistantMsg.toolCalls!.length, equals(1));
        expect(assistantMsg.toolCalls![0].id, equals('tool-call-1'));
        expect(assistantMsg.toolCalls![0].function.name, equals('generate_haiku'));
        
        // Check tool message
        expect(messagesEvent.messages[2].role, equals(MessageRole.tool));
        final toolMsg = messagesEvent.messages[2] as ToolMessage;
        expect(toolMsg.toolCallId, equals('tool-call-1'));
        expect(toolMsg.content, equals('Haiku created'));
      });

      test('decodes RUN_FINISHED event from Python server', () {
        final pythonJson = {
          'type': 'RUN_FINISHED',
          'thread_id': 'thread-123',
          'run_id': 'run-456',
        };

        final event = decoder.decodeJson(pythonJson);
        expect(event, isA<RunFinishedEvent>());
        
        final runEvent = event as RunFinishedEvent;
        expect(runEvent.threadId, equals('thread-123'));
        expect(runEvent.runId, equals('run-456'));
      });
    });

    group('TypeScript Dojo Events', () {
      test('decodes all text message lifecycle events', () {
        final events = [
          {'type': 'TEXT_MESSAGE_START', 'messageId': 'msg-1', 'role': 'assistant'},
          {'type': 'TEXT_MESSAGE_CONTENT', 'messageId': 'msg-1', 'delta': 'Hello '},
          {'type': 'TEXT_MESSAGE_CONTENT', 'messageId': 'msg-1', 'delta': 'world!'},
          {'type': 'TEXT_MESSAGE_END', 'messageId': 'msg-1'},
        ];

        final decodedEvents = events.map((json) => decoder.decodeJson(json)).toList();
        
        expect(decodedEvents[0], isA<TextMessageStartEvent>());
        expect(decodedEvents[1], isA<TextMessageContentEvent>());
        expect(decodedEvents[2], isA<TextMessageContentEvent>());
        expect(decodedEvents[3], isA<TextMessageEndEvent>());
        
        // Verify content accumulation
        final content1 = (decodedEvents[1] as TextMessageContentEvent).delta;
        final content2 = (decodedEvents[2] as TextMessageContentEvent).delta;
        expect(content1 + content2, equals('Hello world!'));
      });

      test('decodes tool call lifecycle events', () {
        final events = [
          {
            'type': 'TOOL_CALL_START',
            'toolCallId': 'tool-1',
            'toolCallName': 'search',
            'parentMessageId': 'msg-1',
          },
          {
            'type': 'TOOL_CALL_ARGS',
            'toolCallId': 'tool-1',
            'delta': '{"query": "AG-UI protocol"}',
          },
          {
            'type': 'TOOL_CALL_END',
            'toolCallId': 'tool-1',
          },
          {
            'type': 'TOOL_CALL_RESULT',
            'messageId': 'msg-2',
            'toolCallId': 'tool-1',
            'content': 'Found 5 results',
            'role': 'tool',
          },
        ];

        final decodedEvents = events.map((json) => decoder.decodeJson(json)).toList();
        
        expect(decodedEvents[0], isA<ToolCallStartEvent>());
        expect(decodedEvents[1], isA<ToolCallArgsEvent>());
        expect(decodedEvents[2], isA<ToolCallEndEvent>());
        expect(decodedEvents[3], isA<ToolCallResultEvent>());
        
        // Verify tool call details
        final startEvent = decodedEvents[0] as ToolCallStartEvent;
        expect(startEvent.toolCallName, equals('search'));
        expect(startEvent.parentMessageId, equals('msg-1'));
        
        final resultEvent = decodedEvents[3] as ToolCallResultEvent;
        expect(resultEvent.content, equals('Found 5 results'));
        expect(resultEvent.role, equals('tool'));
      });

      test('decodes thinking events', () {
        final events = [
          {'type': 'THINKING_START', 'title': 'Planning approach'},
          {'type': 'THINKING_TEXT_MESSAGE_START'},
          {'type': 'THINKING_TEXT_MESSAGE_CONTENT', 'delta': 'Let me think...'},
          {'type': 'THINKING_TEXT_MESSAGE_END'},
          {'type': 'THINKING_END'},
        ];

        final decodedEvents = events.map((json) => decoder.decodeJson(json)).toList();
        
        expect(decodedEvents[0], isA<ThinkingStartEvent>());
        expect((decodedEvents[0] as ThinkingStartEvent).title, equals('Planning approach'));
        expect(decodedEvents[1], isA<ThinkingTextMessageStartEvent>());
        expect(decodedEvents[2], isA<ThinkingTextMessageContentEvent>());
        expect(decodedEvents[3], isA<ThinkingTextMessageEndEvent>());
        expect(decodedEvents[4], isA<ThinkingEndEvent>());
      });

      test('decodes state management events', () {
        final stateSnapshot = {
          'type': 'STATE_SNAPSHOT',
          'snapshot': {
            'counter': 0,
            'users': ['alice', 'bob'],
            'settings': {'theme': 'dark', 'notifications': true},
          },
        };

        final stateDelta = {
          'type': 'STATE_DELTA',
          'delta': [
            {'op': 'replace', 'path': '/counter', 'value': 1},
            {'op': 'add', 'path': '/users/-', 'value': 'charlie'},
          ],
        };

        final snapshotEvent = decoder.decodeJson(stateSnapshot);
        expect(snapshotEvent, isA<StateSnapshotEvent>());
        final snapshot = (snapshotEvent as StateSnapshotEvent).snapshot;
        expect(snapshot['counter'], equals(0));
        expect(snapshot['users'], equals(['alice', 'bob']));

        final deltaEvent = decoder.decodeJson(stateDelta);
        expect(deltaEvent, isA<StateDeltaEvent>());
        final delta = (deltaEvent as StateDeltaEvent).delta;
        expect(delta.length, equals(2));
        expect(delta[0]['op'], equals('replace'));
        expect(delta[1]['op'], equals('add'));
      });

      test('decodes step events', () {
        final events = [
          {'type': 'STEP_STARTED', 'stepName': 'Analyzing request'},
          {'type': 'STEP_FINISHED', 'stepName': 'Analyzing request'},
        ];

        final decodedEvents = events.map((json) => decoder.decodeJson(json)).toList();
        
        expect(decodedEvents[0], isA<StepStartedEvent>());
        expect((decodedEvents[0] as StepStartedEvent).stepName, equals('Analyzing request'));
        expect(decodedEvents[1], isA<StepFinishedEvent>());
        expect((decodedEvents[1] as StepFinishedEvent).stepName, equals('Analyzing request'));
      });
    });

    group('Stream Processing', () {
      test('processes SSE stream with mixed events', () async {
        final sseController = StreamController<SseMessage>();
        final eventStream = adapter.fromSseStream(sseController.stream);
        
        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);
        
        // Simulate server stream
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'RUN_STARTED', 'thread_id': 't1', 'run_id': 'r1'}),
        ));
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'TEXT_MESSAGE_START', 'messageId': 'm1', 'role': 'assistant'}),
        ));
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'TEXT_MESSAGE_CONTENT', 'messageId': 'm1', 'delta': 'Hello'}),
        ));
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'TEXT_MESSAGE_END', 'messageId': 'm1'}),
        ));
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'RUN_FINISHED', 'thread_id': 't1', 'run_id': 'r1'}),
        ));
        
        await sseController.close();
        await subscription.cancel();
        
        expect(events.length, equals(5));
        expect(events.first, isA<RunStartedEvent>());
        expect(events.last, isA<RunFinishedEvent>());
      });

      test('handles malformed events gracefully', () async {
        final sseController = StreamController<SseMessage>();
        final errors = <Object>[];
        final eventStream = adapter.fromSseStream(
          sseController.stream,
          skipInvalidEvents: true,
          onError: (error, stack) => errors.add(error),
        );
        
        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);
        
        // Mix valid and invalid events
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'RUN_STARTED', 'thread_id': 't1', 'run_id': 'r1'}),
        ));
        sseController.add(SseMessage(data: 'not json')); // Invalid
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'INVALID_TYPE'}), // Unknown type
        ));
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'TEXT_MESSAGE_CONTENT', 'messageId': 'm1', 'delta': ''}), // Invalid: empty delta
        ));
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'RUN_FINISHED', 'thread_id': 't1', 'run_id': 'r1'}),
        ));
        
        await sseController.close();
        await subscription.cancel();
        
        // Should only get valid events
        expect(events.length, equals(2));
        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<RunFinishedEvent>());
        
        // Should have collected errors for invalid events
        expect(errors.length, equals(3));
        expect(errors[0], isA<DecodingError>());
        expect(errors[1], isA<DecodingError>());
        expect(errors[2], isA<DecodingError>()); // Validation errors are wrapped in DecodingError
      });

      test('handles unknown fields for forward compatibility', () {
        // Events with extra fields should still decode
        final jsonWithExtra = {
          'type': 'TEXT_MESSAGE_START',
          'messageId': 'msg-1',
          'role': 'assistant',
          'futureField': 'some value', // Unknown field
          'metadata': {'key': 'value'}, // Unknown field
        };

        final event = decoder.decodeJson(jsonWithExtra);
        expect(event, isA<TextMessageStartEvent>());
        
        final textEvent = event as TextMessageStartEvent;
        expect(textEvent.messageId, equals('msg-1'));
        expect(textEvent.role, equals(TextMessageRole.assistant));
        // Unknown fields are preserved in rawEvent if needed
      });

      test('validates required fields strictly', () {
        // Missing required field
        expect(
          () => decoder.decodeJson({'type': 'TEXT_MESSAGE_START'}),
          throwsA(isA<DecodingError>()),
        );

        // Empty required field - validation error is wrapped in DecodingError
        expect(
          () => decoder.decodeJson({
            'type': 'TEXT_MESSAGE_CONTENT',
            'messageId': 'msg-1',
            'delta': '', // Empty delta not allowed
          }),
          throwsA(isA<DecodingError>()),
        );

        // Invalid event type
        expect(
          () => decoder.decodeJson({'type': 'NOT_A_REAL_EVENT'}),
          throwsA(isA<DecodingError>()),
        );
      });
    });

    group('Error Recovery', () {
      test('continues processing after encountering errors', () async {
        final rawController = StreamController<String>();
        final errors = <Object>[];
        final eventStream = adapter.fromRawSseStream(
          rawController.stream,
          skipInvalidEvents: true,
          onError: (error, stack) => errors.add(error),
        );
        
        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);
        
        // Send a mix of valid and invalid SSE data
        rawController.add('data: {"type":"RUN_STARTED","thread_id":"t1","run_id":"r1"}\n\n');
        rawController.add('data: {broken json\n\n'); // Invalid JSON
        rawController.add('data: {"type":"TEXT_MESSAGE_START","messageId":"m1"}\n\n');
        rawController.add('data: : \n\n'); // SSE comment/keepalive
        rawController.add('data: {"type":"TEXT_MESSAGE_END","messageId":"m1"}\n\n');
        
        await rawController.close();
        await subscription.cancel();
        
        // Should process valid events and skip invalid ones
        expect(events.length, equals(3));
        expect(errors.length, equals(1)); // Only the broken JSON
      });

      test('preserves event order despite errors', () async {
        final sseController = StreamController<SseMessage>();
        final eventStream = adapter.fromSseStream(
          sseController.stream,
          skipInvalidEvents: true,
        );
        
        final eventTypes = <String>[];
        final subscription = eventStream.listen((event) {
          eventTypes.add(event.eventType.value);
        });
        
        // Send events in specific order with errors in between
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'RUN_STARTED', 'thread_id': 't1', 'run_id': 'r1'}),
        ));
        sseController.add(SseMessage(data: 'invalid')); // Error - skipped
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'TEXT_MESSAGE_START', 'messageId': 'm1'}),
        ));
        sseController.add(SseMessage(data: '{"type": "UNKNOWN"}')); // Error - skipped
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'TEXT_MESSAGE_END', 'messageId': 'm1'}),
        ));
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'RUN_FINISHED', 'thread_id': 't1', 'run_id': 'r1'}),
        ));
        
        await sseController.close();
        await subscription.cancel();
        
        // Order should be preserved for valid events
        expect(eventTypes, equals([
          'RUN_STARTED',
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_END',
          'RUN_FINISHED',
        ]));
      });
    });
  });
}