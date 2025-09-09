import 'dart:async';

import 'package:ag_ui/src/encoder/stream_adapter.dart';
import 'package:ag_ui/src/events/events.dart';
import 'package:ag_ui/src/sse/sse_message.dart';
import 'package:test/test.dart';

void main() {
  group('EventStreamAdapter', () {
    late EventStreamAdapter adapter;

    setUp(() {
      adapter = EventStreamAdapter();
    });

    group('fromSseStream', () {
      test('converts SSE messages to typed events', () async {
        final sseController = StreamController<SseMessage>();
        final eventStream = adapter.fromSseStream(sseController.stream);
        
        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);
        
        // Add SSE messages
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_START","messageId":"msg1","role":"assistant"}',
        ));
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg1","delta":"Hello"}',
        ));
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_END","messageId":"msg1"}',
        ));
        
        await sseController.close();
        await subscription.cancel();
        
        expect(events.length, equals(3));
        expect(events[0], isA<TextMessageStartEvent>());
        expect(events[1], isA<TextMessageContentEvent>());
        expect(events[2], isA<TextMessageEndEvent>());
      });

      test('ignores non-data SSE messages', () async {
        final sseController = StreamController<SseMessage>();
        final eventStream = adapter.fromSseStream(sseController.stream);
        
        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);
        
        // Add various SSE message types
        sseController.add(const SseMessage(id: '123')); // No data
        sseController.add(const SseMessage(event: 'custom')); // No data
        sseController.add(const SseMessage(retry: Duration(milliseconds: 1000))); // No data
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_START","messageId":"msg1"}',
        ));
        sseController.add(SseMessage(data: '')); // Empty data
        
        await sseController.close();
        await subscription.cancel();
        
        expect(events.length, equals(1));
        expect(events[0], isA<TextMessageStartEvent>());
      });

      test('handles errors when skipInvalidEvents is false', () async {
        final sseController = StreamController<SseMessage>();
        final eventStream = adapter.fromSseStream(
          sseController.stream,
          skipInvalidEvents: false,
        );
        
        final events = <BaseEvent>[];
        final errors = <Object>[];
        final subscription = eventStream.listen(
          events.add,
          onError: errors.add,
        );
        
        // Add valid and invalid messages
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_START","messageId":"msg1"}',
        ));
        sseController.add(SseMessage(
          data: 'invalid json',
        ));
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_END","messageId":"msg1"}',
        ));
        
        await sseController.close();
        await subscription.cancel();
        
        expect(events.length, equals(2));
        expect(errors.length, equals(1));
      });

      test('skips invalid events when skipInvalidEvents is true', () async {
        final sseController = StreamController<SseMessage>();
        final collectedErrors = <Object>[];
        final eventStream = adapter.fromSseStream(
          sseController.stream,
          skipInvalidEvents: true,
          onError: (error, stack) => collectedErrors.add(error),
        );
        
        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);
        
        // Add valid and invalid messages
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_START","messageId":"msg1"}',
        ));
        sseController.add(SseMessage(
          data: 'invalid json',
        ));
        sseController.add(SseMessage(
          data: '{"type":"UNKNOWN_EVENT"}', // Unknown event type
        ));
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_END","messageId":"msg1"}',
        ));
        
        await sseController.close();
        await subscription.cancel();
        
        expect(events.length, equals(2));
        expect(collectedErrors.length, equals(2));
      });
    });

    group('fromRawSseStream', () {
      test('handles complete SSE messages', () async {
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);
        
        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);
        
        // Add complete SSE messages
        rawController.add('data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\n\n');
        rawController.add('data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}\n\n');
        
        await rawController.close();
        await subscription.cancel();
        
        expect(events.length, equals(2));
        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<RunFinishedEvent>());
      });

      test('handles partial messages across chunks', () async {
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);
        
        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);
        
        // Split message across chunks
        rawController.add('data: {"type":"TEXT_MES');
        rawController.add('SAGE_START","messageI');
        rawController.add('d":"msg1"}\n\n');
        
        await rawController.close();
        await subscription.cancel();
        
        expect(events.length, equals(1));
        expect(events[0], isA<TextMessageStartEvent>());
        final event = events[0] as TextMessageStartEvent;
        expect(event.messageId, equals('msg1'));
      });

      test('handles multi-line data fields', () async {
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);
        
        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);
        
        // Multi-line data
        rawController.add('data: {"type":"TEXT_MESSAGE_CONTENT",\n');
        rawController.add('data: "messageId":"msg1",\n');
        rawController.add('data: "delta":"Hello"}\n\n');
        
        await rawController.close();
        await subscription.cancel();
        
        expect(events.length, equals(1));
        expect(events[0], isA<TextMessageContentEvent>());
        final event = events[0] as TextMessageContentEvent;
        expect(event.delta, equals('Hello'));
      });

      test('ignores non-data lines', () async {
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);
        
        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);
        
        rawController.add('id: 123\n');
        rawController.add('event: custom\n');
        rawController.add(': comment\n');
        rawController.add('data: {"type":"CUSTOM","name":"test","value":42}\n\n');
        rawController.add('retry: 1000\n');
        
        await rawController.close();
        await subscription.cancel();
        
        expect(events.length, equals(1));
        expect(events[0], isA<CustomEvent>());
      });

      test('processes remaining buffered data on close', () async {
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);
        
        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);
        
        // Add data without final newlines
        rawController.add('data: {"type":"STATE_SNAPSHOT","snapshot":{"count":42}}');
        
        await rawController.close();
        await subscription.cancel();
        
        expect(events.length, equals(1));
        expect(events[0], isA<StateSnapshotEvent>());
        final event = events[0] as StateSnapshotEvent;
        expect(event.snapshot['count'], equals(42));
      });
    });

    group('filterByType', () {
      test('filters events by specific type', () async {
        final controller = StreamController<BaseEvent>();
        final filtered = EventStreamAdapter.filterByType<TextMessageStartEvent>(
          controller.stream,
        );
        
        final events = <TextMessageStartEvent>[];
        final subscription = filtered.listen(events.add);
        
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller.add(TextMessageContentEvent(messageId: 'msg1', delta: 'Hello'));
        controller.add(TextMessageStartEvent(messageId: 'msg2'));
        controller.add(ToolCallStartEvent(
          toolCallId: 'tool1',
          toolCallName: 'search',
        ));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));
        
        await controller.close();
        await subscription.cancel();
        
        expect(events.length, equals(2));
        expect(events[0].messageId, equals('msg1'));
        expect(events[1].messageId, equals('msg2'));
      });
    });

    group('groupRelatedEvents', () {
      test('groups text message events by messageId', () async {
        final controller = StreamController<BaseEvent>();
        final grouped = EventStreamAdapter.groupRelatedEvents(controller.stream);
        
        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);
        
        // Complete message sequence
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller.add(TextMessageContentEvent(messageId: 'msg1', delta: 'Hello'));
        controller.add(TextMessageContentEvent(messageId: 'msg1', delta: ' world'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));
        
        await controller.close();
        await subscription.cancel();
        
        expect(groups.length, equals(1));
        expect(groups[0].length, equals(4));
        expect(groups[0][0], isA<TextMessageStartEvent>());
        expect(groups[0][1], isA<TextMessageContentEvent>());
        expect(groups[0][2], isA<TextMessageContentEvent>());
        expect(groups[0][3], isA<TextMessageEndEvent>());
      });

      test('groups tool call events by toolCallId', () async {
        final controller = StreamController<BaseEvent>();
        final grouped = EventStreamAdapter.groupRelatedEvents(controller.stream);
        
        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);
        
        // Complete tool call sequence
        controller.add(ToolCallStartEvent(
          toolCallId: 'tool1',
          toolCallName: 'search',
        ));
        controller.add(ToolCallArgsEvent(
          toolCallId: 'tool1',
          delta: '{"query":',
        ));
        controller.add(ToolCallArgsEvent(
          toolCallId: 'tool1',
          delta: '"test"}',
        ));
        controller.add(ToolCallEndEvent(toolCallId: 'tool1'));
        
        await controller.close();
        await subscription.cancel();
        
        expect(groups.length, equals(1));
        expect(groups[0].length, equals(4));
        expect(groups[0][0], isA<ToolCallStartEvent>());
        expect(groups[0][1], isA<ToolCallArgsEvent>());
        expect(groups[0][2], isA<ToolCallArgsEvent>());
        expect(groups[0][3], isA<ToolCallEndEvent>());
      });

      test('handles interleaved message groups', () async {
        final controller = StreamController<BaseEvent>();
        final grouped = EventStreamAdapter.groupRelatedEvents(controller.stream);
        
        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);
        
        // Interleaved messages
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller.add(TextMessageStartEvent(messageId: 'msg2'));
        controller.add(TextMessageContentEvent(messageId: 'msg1', delta: 'A'));
        controller.add(TextMessageContentEvent(messageId: 'msg2', delta: 'B'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));
        controller.add(TextMessageEndEvent(messageId: 'msg2'));
        
        await controller.close();
        await subscription.cancel();
        
        expect(groups.length, equals(2));
        // First completed group (msg1)
        expect(groups[0].length, equals(3));
        expect((groups[0][0] as TextMessageStartEvent).messageId, equals('msg1'));
        // Second completed group (msg2)
        expect(groups[1].length, equals(3));
        expect((groups[1][0] as TextMessageStartEvent).messageId, equals('msg2'));
      });

      test('emits single events not part of groups', () async {
        final controller = StreamController<BaseEvent>();
        final grouped = EventStreamAdapter.groupRelatedEvents(controller.stream);
        
        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);
        
        controller.add(RunStartedEvent(threadId: 't1', runId: 'r1'));
        controller.add(StateSnapshotEvent(snapshot: {'count': 0}));
        controller.add(CustomEvent(name: 'test', value: 42));
        
        await controller.close();
        await subscription.cancel();
        
        expect(groups.length, equals(3));
        expect(groups[0].length, equals(1));
        expect(groups[0][0], isA<RunStartedEvent>());
        expect(groups[1].length, equals(1));
        expect(groups[1][0], isA<StateSnapshotEvent>());
        expect(groups[2].length, equals(1));
        expect(groups[2][0], isA<CustomEvent>());
      });

      test('emits incomplete groups on stream close', () async {
        final controller = StreamController<BaseEvent>();
        final grouped = EventStreamAdapter.groupRelatedEvents(controller.stream);
        
        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);
        
        // Incomplete message (no END event)
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller.add(TextMessageContentEvent(messageId: 'msg1', delta: 'Hello'));
        
        await controller.close();
        await subscription.cancel();
        
        expect(groups.length, equals(1));
        expect(groups[0].length, equals(2));
        expect(groups[0][0], isA<TextMessageStartEvent>());
        expect(groups[0][1], isA<TextMessageContentEvent>());
      });
    });

    group('accumulateTextMessages', () {
      test('accumulates text message content', () async {
        final controller = StreamController<BaseEvent>();
        final accumulated = EventStreamAdapter.accumulateTextMessages(
          controller.stream,
        );
        
        final messages = <String>[];
        final subscription = accumulated.listen(messages.add);
        
        // Complete message
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller.add(TextMessageContentEvent(messageId: 'msg1', delta: 'Hello'));
        controller.add(TextMessageContentEvent(messageId: 'msg1', delta: ', '));
        controller.add(TextMessageContentEvent(messageId: 'msg1', delta: 'world!'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));
        
        await controller.close();
        await subscription.cancel();
        
        expect(messages.length, equals(1));
        expect(messages[0], equals('Hello, world!'));
      });

      test('handles multiple concurrent messages', () async {
        final controller = StreamController<BaseEvent>();
        final accumulated = EventStreamAdapter.accumulateTextMessages(
          controller.stream,
        );
        
        final messages = <String>[];
        final subscription = accumulated.listen(messages.add);
        
        // Interleaved messages
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller.add(TextMessageStartEvent(messageId: 'msg2'));
        controller.add(TextMessageContentEvent(messageId: 'msg1', delta: 'First'));
        controller.add(TextMessageContentEvent(messageId: 'msg2', delta: 'Second'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));
        controller.add(TextMessageContentEvent(messageId: 'msg2', delta: ' message'));
        controller.add(TextMessageEndEvent(messageId: 'msg2'));
        
        await controller.close();
        await subscription.cancel();
        
        expect(messages.length, equals(2));
        expect(messages[0], equals('First'));
        expect(messages[1], equals('Second message'));
      });

      test('handles chunk events', () async {
        final controller = StreamController<BaseEvent>();
        final accumulated = EventStreamAdapter.accumulateTextMessages(
          controller.stream,
        );
        
        final messages = <String>[];
        final subscription = accumulated.listen(messages.add);
        
        // Chunk events (complete content in single event)
        controller.add(TextMessageChunkEvent(
          messageId: 'msg1',
          delta: 'Complete message 1',
        ));
        controller.add(TextMessageChunkEvent(
          messageId: 'msg2',
          delta: 'Complete message 2',
        ));
        
        await controller.close();
        await subscription.cancel();
        
        expect(messages.length, equals(2));
        expect(messages[0], equals('Complete message 1'));
        expect(messages[1], equals('Complete message 2'));
      });

      test('ignores non-text message events', () async {
        final controller = StreamController<BaseEvent>();
        final accumulated = EventStreamAdapter.accumulateTextMessages(
          controller.stream,
        );
        
        final messages = <String>[];
        final subscription = accumulated.listen(messages.add);
        
        controller.add(RunStartedEvent(threadId: 't1', runId: 'r1'));
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller.add(ToolCallStartEvent(
          toolCallId: 'tool1',
          toolCallName: 'search',
        ));
        controller.add(TextMessageContentEvent(messageId: 'msg1', delta: 'Test'));
        controller.add(StateSnapshotEvent(snapshot: {}));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));
        
        await controller.close();
        await subscription.cancel();
        
        expect(messages.length, equals(1));
        expect(messages[0], equals('Test'));
      });

      test('handles empty content', () async {
        final controller = StreamController<BaseEvent>();
        final accumulated = EventStreamAdapter.accumulateTextMessages(
          controller.stream,
        );
        
        final messages = <String>[];
        final subscription = accumulated.listen(messages.add);
        
        // Message with no content events
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));
        
        await controller.close();
        await subscription.cancel();
        
        expect(messages.length, equals(1));
        expect(messages[0], equals(''));
      });
    });
  });
}