import 'package:test/test.dart';
import 'package:ag_ui/ag_ui.dart';

void main() {
  group('Event Types', () {
    group('TextMessageEvents', () {
      test('TextMessageStartEvent serialization', () {
        final event = TextMessageStartEvent(
          messageId: 'msg_001',
          role: TextMessageRole.assistant,
          timestamp: 1234567890,
        );

        final json = event.toJson();
        expect(json['type'], 'TEXT_MESSAGE_START');
        expect(json['messageId'], 'msg_001');
        expect(json['role'], 'assistant');
        expect(json['timestamp'], 1234567890);

        final decoded = TextMessageStartEvent.fromJson(json);
        expect(decoded.messageId, event.messageId);
        expect(decoded.role, event.role);
        expect(decoded.timestamp, event.timestamp);
      });

      test('TextMessageContentEvent validation', () {
        // Valid event with non-empty delta
        final validEvent = TextMessageContentEvent(
          messageId: 'msg_001',
          delta: 'Hello world',
        );
        expect(validEvent.delta, 'Hello world');

        // Invalid event with empty delta should throw
        final invalidJson = {
          'type': 'TEXT_MESSAGE_CONTENT',
          'messageId': 'msg_001',
          'delta': '',
        };

        expect(
          () => TextMessageContentEvent.fromJson(invalidJson),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('TextMessageChunkEvent optional fields', () {
        final event = TextMessageChunkEvent(
          messageId: 'msg_001',
          role: TextMessageRole.user,
          delta: 'chunk content',
        );

        final json = event.toJson();
        expect(json['messageId'], 'msg_001');
        expect(json['role'], 'user');
        expect(json['delta'], 'chunk content');

        // Test with all fields null
        final minimalEvent = TextMessageChunkEvent();
        final minimalJson = minimalEvent.toJson();
        expect(minimalJson.containsKey('messageId'), false);
        expect(minimalJson.containsKey('role'), false);
        expect(minimalJson.containsKey('delta'), false);
      });
    });

    group('ToolCallEvents', () {
      test('ToolCallStartEvent with parent message', () {
        final event = ToolCallStartEvent(
          toolCallId: 'call_001',
          toolCallName: 'get_weather',
          parentMessageId: 'msg_001',
        );

        final json = event.toJson();
        expect(json['type'], 'TOOL_CALL_START');
        expect(json['toolCallId'], 'call_001');
        expect(json['toolCallName'], 'get_weather');
        expect(json['parentMessageId'], 'msg_001');

        final decoded = ToolCallStartEvent.fromJson(json);
        expect(decoded.toolCallId, event.toolCallId);
        expect(decoded.toolCallName, event.toolCallName);
        expect(decoded.parentMessageId, event.parentMessageId);
      });

      test('ToolCallResultEvent role field', () {
        final event = ToolCallResultEvent(
          messageId: 'msg_001',
          toolCallId: 'call_001',
          content: 'Weather: Sunny, 72°F',
          role: 'tool',
        );

        final json = event.toJson();
        expect(json['role'], 'tool');

        final decoded = ToolCallResultEvent.fromJson(json);
        expect(decoded.role, 'tool');
      });
    });

    group('StateEvents', () {
      test('StateSnapshotEvent with complex state', () {
        final complexState = {
          'counter': 42,
          'messages': ['msg1', 'msg2'],
          'metadata': {
            'timestamp': 1234567890,
            'user': 'test_user',
          },
        };

        final event = StateSnapshotEvent(snapshot: complexState);

        final json = event.toJson();
        expect(json['type'], 'STATE_SNAPSHOT');
        expect(json['snapshot'], complexState);

        final decoded = StateSnapshotEvent.fromJson(json);
        expect(decoded.snapshot, complexState);
      });

      test('StateDeltaEvent with JSON Patch operations', () {
        final delta = [
          {'op': 'add', 'path': '/foo', 'value': 'bar'},
          {'op': 'remove', 'path': '/baz'},
          {'op': 'replace', 'path': '/qux', 'value': 42},
        ];

        final event = StateDeltaEvent(delta: delta);

        final json = event.toJson();
        expect(json['type'], 'STATE_DELTA');
        expect(json['delta'], delta);

        final decoded = StateDeltaEvent.fromJson(json);
        expect(decoded.delta, delta);
      });

      test('MessagesSnapshotEvent with mixed message types', () {
        final messages = [
          UserMessage(id: '1', content: 'Hello'),
          AssistantMessage(id: '2', content: 'Hi there'),
          ToolMessage(
            id: '3',
            content: 'Result',
            toolCallId: 'call_001',
          ),
        ];

        final event = MessagesSnapshotEvent(messages: messages);

        final json = event.toJson();
        expect(json['type'], 'MESSAGES_SNAPSHOT');
        expect(json['messages'].length, 3);

        final decoded = MessagesSnapshotEvent.fromJson(json);
        expect(decoded.messages.length, 3);
        expect(decoded.messages[0], isA<UserMessage>());
        expect(decoded.messages[1], isA<AssistantMessage>());
        expect(decoded.messages[2], isA<ToolMessage>());
      });
    });

    group('LifecycleEvents', () {
      test('RunStartedEvent handles both camelCase and snake_case', () {
        // Test camelCase
        final camelJson = {
          'type': 'RUN_STARTED',
          'threadId': 'thread_001',
          'runId': 'run_001',
        };

        final camelEvent = RunStartedEvent.fromJson(camelJson);
        expect(camelEvent.threadId, 'thread_001');
        expect(camelEvent.runId, 'run_001');

        // Test snake_case
        final snakeJson = {
          'type': 'RUN_STARTED',
          'thread_id': 'thread_002',
          'run_id': 'run_002',
        };

        final snakeEvent = RunStartedEvent.fromJson(snakeJson);
        expect(snakeEvent.threadId, 'thread_002');
        expect(snakeEvent.runId, 'run_002');
      });

      test('RunFinishedEvent with result', () {
        final result = {'status': 'success', 'data': [1, 2, 3]};
        final event = RunFinishedEvent(
          threadId: 'thread_001',
          runId: 'run_001',
          result: result,
        );

        final json = event.toJson();
        expect(json['result'], result);

        final decoded = RunFinishedEvent.fromJson(json);
        expect(decoded.result, result);
      });

      test('RunErrorEvent with error code', () {
        final event = RunErrorEvent(
          message: 'Something went wrong',
          code: 'ERR_TIMEOUT',
        );

        final json = event.toJson();
        expect(json['message'], 'Something went wrong');
        expect(json['code'], 'ERR_TIMEOUT');

        final decoded = RunErrorEvent.fromJson(json);
        expect(decoded.message, event.message);
        expect(decoded.code, event.code);
      });

      test('StepEvents handle both camelCase and snake_case', () {
        // StepStartedEvent
        final stepStartSnake = {
          'type': 'STEP_STARTED',
          'step_name': 'processing',
        };

        final stepStart = StepStartedEvent.fromJson(stepStartSnake);
        expect(stepStart.stepName, 'processing');

        // StepFinishedEvent
        final stepEndCamel = {
          'type': 'STEP_FINISHED',
          'stepName': 'processing',
        };

        final stepEnd = StepFinishedEvent.fromJson(stepEndCamel);
        expect(stepEnd.stepName, 'processing');
      });
    });

    group('Event Factory', () {
      test('should create correct event type based on type field', () {
        final eventJsons = [
          {'type': 'TEXT_MESSAGE_START', 'messageId': 'msg_001'},
          {'type': 'TOOL_CALL_START', 'toolCallId': 'call_001', 'toolCallName': 'test'},
          {'type': 'STATE_SNAPSHOT', 'snapshot': {}},
          {'type': 'RUN_STARTED', 'threadId': 'thread_001', 'runId': 'run_001'},
          {'type': 'THINKING_START'},
          {'type': 'CUSTOM', 'name': 'my_event', 'value': 'data'},
        ];

        final events = eventJsons.map((json) => BaseEvent.fromJson(json)).toList();

        expect(events[0], isA<TextMessageStartEvent>());
        expect(events[1], isA<ToolCallStartEvent>());
        expect(events[2], isA<StateSnapshotEvent>());
        expect(events[3], isA<RunStartedEvent>());
        expect(events[4], isA<ThinkingStartEvent>());
        expect(events[5], isA<CustomEvent>());
      });

      test('should throw on invalid event type', () {
        final json = {
          'type': 'INVALID_EVENT_TYPE',
          'data': 'some data',
        };

        expect(
          () => BaseEvent.fromJson(json),
          throwsArgumentError,
        );
      });
    });

    group('ReasoningEvents', () {
      test('round-trips ReasoningStartEvent', () {
        final event = ReasoningStartEvent(messageId: 'reas_1');
        final decoded = ReasoningStartEvent.fromJson(event.toJson());
        expect(decoded.messageId, 'reas_1');
      });

      test('round-trips ReasoningMessageContentEvent', () {
        final event = ReasoningMessageContentEvent(
          messageId: 'reas_1',
          delta: 'thinking step',
        );
        final decoded = ReasoningMessageContentEvent.fromJson(event.toJson());
        expect(decoded.delta, 'thinking step');
      });

      test('ReasoningMessageContentEvent rejects empty delta', () {
        expect(
          () => ReasoningMessageContentEvent.fromJson({
            'type': 'REASONING_MESSAGE_CONTENT',
            'messageId': 'reas_1',
            'delta': '',
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('round-trips ReasoningEncryptedValueEvent', () {
        final event = ReasoningEncryptedValueEvent(
          subtype: ReasoningEncryptedValueSubtype.message,
          entityId: 'reas_1',
          encryptedValue: 'ENC',
        );
        final json = event.toJson();
        expect(json['subtype'], 'message');
        final decoded = ReasoningEncryptedValueEvent.fromJson(json);
        expect(decoded.subtype, ReasoningEncryptedValueSubtype.message);
      });

      test('round-trips ReasoningEndEvent', () {
        final event = ReasoningEndEvent(messageId: 'reas_1');
        final decoded = ReasoningEndEvent.fromJson(event.toJson());
        expect(decoded.messageId, 'reas_1');
      });

      test('round-trips ReasoningMessageStartEvent', () {
        final event = ReasoningMessageStartEvent(messageId: 'reas_1');
        final json = event.toJson();
        expect(json['role'], 'reasoning');
        final decoded = ReasoningMessageStartEvent.fromJson(json);
        expect(decoded.messageId, 'reas_1');
      });

      test('round-trips ReasoningMessageEndEvent', () {
        final event = ReasoningMessageEndEvent(messageId: 'reas_1');
        final decoded = ReasoningMessageEndEvent.fromJson(event.toJson());
        expect(decoded.messageId, 'reas_1');
      });

      test('round-trips ReasoningMessageChunkEvent with fields', () {
        final event = ReasoningMessageChunkEvent(
          messageId: 'reas_1',
          delta: 'chunk',
        );
        final decoded = ReasoningMessageChunkEvent.fromJson(event.toJson());
        expect(decoded.messageId, 'reas_1');
        expect(decoded.delta, 'chunk');
      });

      test('round-trips ReasoningMessageChunkEvent with null fields', () {
        final event = ReasoningMessageChunkEvent();
        final json = event.toJson();
        expect(json.containsKey('messageId'), isFalse);
        expect(json.containsKey('delta'), isFalse);
        final decoded = ReasoningMessageChunkEvent.fromJson(json);
        expect(decoded.messageId, isNull);
        expect(decoded.delta, isNull);
      });

      test('ReasoningEncryptedValueSubtype.fromString rejects unknown value',
          () {
        expect(
          () => ReasoningEncryptedValueSubtype.fromString('bogus'),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('BaseEvent.fromJson routes all REASONING_* events', () {
        expect(
          BaseEvent.fromJson({'type': 'REASONING_START', 'messageId': 'r'}),
          isA<ReasoningStartEvent>(),
        );
        expect(
          BaseEvent.fromJson({'type': 'REASONING_END', 'messageId': 'r'}),
          isA<ReasoningEndEvent>(),
        );
        expect(
          BaseEvent.fromJson(
              {'type': 'REASONING_MESSAGE_START', 'messageId': 'r'}),
          isA<ReasoningMessageStartEvent>(),
        );
        expect(
          BaseEvent.fromJson({
            'type': 'REASONING_MESSAGE_CONTENT',
            'messageId': 'r',
            'delta': 'd',
          }),
          isA<ReasoningMessageContentEvent>(),
        );
        expect(
          BaseEvent.fromJson(
              {'type': 'REASONING_MESSAGE_END', 'messageId': 'r'}),
          isA<ReasoningMessageEndEvent>(),
        );
        expect(
          BaseEvent.fromJson({'type': 'REASONING_MESSAGE_CHUNK'}),
          isA<ReasoningMessageChunkEvent>(),
        );
        expect(
          BaseEvent.fromJson({
            'type': 'REASONING_ENCRYPTED_VALUE',
            'subtype': 'tool-call',
            'entityId': 'e',
            'encryptedValue': 'v',
          }),
          isA<ReasoningEncryptedValueEvent>(),
        );
      });

      test('copyWith overrides fields on each reasoning event', () {
        final start = ReasoningStartEvent(messageId: 'a', timestamp: 1)
            .copyWith(messageId: 'b', timestamp: 2);
        expect(start.messageId, 'b');
        expect(start.timestamp, 2);

        final end = ReasoningEndEvent(messageId: 'a').copyWith(messageId: 'b');
        expect(end.messageId, 'b');

        final msgStart = ReasoningMessageStartEvent(messageId: 'a')
            .copyWith(messageId: 'b');
        expect(msgStart.messageId, 'b');

        final msgContent = ReasoningMessageContentEvent(
          messageId: 'a',
          delta: 'x',
        ).copyWith(messageId: 'b', delta: 'y');
        expect(msgContent.messageId, 'b');
        expect(msgContent.delta, 'y');

        final msgEnd = ReasoningMessageEndEvent(messageId: 'a')
            .copyWith(messageId: 'b');
        expect(msgEnd.messageId, 'b');

        final chunk = ReasoningMessageChunkEvent(messageId: 'a', delta: 'x')
            .copyWith(messageId: 'b', delta: 'y');
        expect(chunk.messageId, 'b');
        expect(chunk.delta, 'y');

        final enc = ReasoningEncryptedValueEvent(
          subtype: ReasoningEncryptedValueSubtype.toolCall,
          entityId: 'a',
          encryptedValue: 'x',
        ).copyWith(
          subtype: ReasoningEncryptedValueSubtype.message,
          entityId: 'b',
          encryptedValue: 'y',
        );
        expect(enc.subtype, ReasoningEncryptedValueSubtype.message);
        expect(enc.entityId, 'b');
        expect(enc.encryptedValue, 'y');
      });

      test('copyWith preserves fields when no overrides given', () {
        final original = ReasoningMessageContentEvent(
          messageId: 'a',
          delta: 'x',
          timestamp: 1,
        );
        final copy = original.copyWith();
        expect(copy.messageId, 'a');
        expect(copy.delta, 'x');
        expect(copy.timestamp, 1);
      });
    });

    group('ActivityDeltaEvent', () {
      test('round-trips patch array', () {
        final event = ActivityDeltaEvent(
          messageId: 'act_1',
          activityType: 'upload',
          patch: [
            {'op': 'replace', 'path': '/progress', 'value': 0.75},
          ],
        );
        final decoded = ActivityDeltaEvent.fromJson(event.toJson());
        expect(decoded.patch, hasLength(1));
        expect(decoded.activityType, 'upload');
      });

      test('BaseEvent.fromJson routes ACTIVITY_DELTA', () {
        final event = BaseEvent.fromJson({
          'type': 'ACTIVITY_DELTA',
          'messageId': 'act_1',
          'activityType': 'upload',
          'patch': [],
        });
        expect(event, isA<ActivityDeltaEvent>());
      });

      test('copyWith overrides fields', () {
        final original = ActivityDeltaEvent(
          messageId: 'a',
          activityType: 'upload',
          patch: [],
          timestamp: 1,
        );
        final copy = original.copyWith(
          messageId: 'b',
          activityType: 'download',
          patch: [
            {'op': 'add', 'path': '/x', 'value': 1},
          ],
          timestamp: 2,
        );
        expect(copy.messageId, 'b');
        expect(copy.activityType, 'download');
        expect(copy.patch, hasLength(1));
        expect(copy.timestamp, 2);
      });
    });

    group('ThinkingEvents', () {
      test('ThinkingStartEvent with title', () {
        final event = ThinkingStartEvent(title: 'Processing request');

        final json = event.toJson();
        expect(json['type'], 'THINKING_START');
        expect(json['title'], 'Processing request');

        final decoded = ThinkingStartEvent.fromJson(json);
        expect(decoded.title, 'Processing request');
      });

      test('ThinkingTextMessageContentEvent delta validation', () {
        final invalidJson = {
          'type': 'THINKING_TEXT_MESSAGE_CONTENT',
          'delta': '',
        };

        expect(
          () => ThinkingTextMessageContentEvent.fromJson(invalidJson),
          throwsA(isA<AGUIValidationError>()),
        );
      });
    });

    group('Raw and Custom Events', () {
      test('RawEvent with source', () {
        final rawEventData = {
          'original': 'event',
          'data': [1, 2, 3],
        };

        final event = RawEvent(
          event: rawEventData,
          source: 'external_api',
        );

        final json = event.toJson();
        expect(json['event'], rawEventData);
        expect(json['source'], 'external_api');

        final decoded = RawEvent.fromJson(json);
        expect(decoded.event, rawEventData);
        expect(decoded.source, 'external_api');
      });

      test('CustomEvent with complex value', () {
        final customValue = {
          'action': 'update_ui',
          'parameters': {'theme': 'dark', 'language': 'en'},
        };

        final event = CustomEvent(
          name: 'ui_config_change',
          value: customValue,
        );

        final json = event.toJson();
        expect(json['name'], 'ui_config_change');
        expect(json['value'], customValue);

        final decoded = CustomEvent.fromJson(json);
        expect(decoded.name, 'ui_config_change');
        expect(decoded.value, customValue);
      });
    });

    group('ActivityEvents', () {
      test('ActivitySnapshotEvent serialization with spec fields', () {
        final content = {'skill': 'rag', 'tool_name': 'search'};
        final event = ActivitySnapshotEvent(
          messageId: 'rag:abc123',
          activityType: 'skill_tool_call',
          content: content,
        );

        final json = event.toJson();
        expect(json['type'], 'ACTIVITY_SNAPSHOT');
        expect(json['messageId'], 'rag:abc123');
        expect(json['activityType'], 'skill_tool_call');
        expect(json['content'], content);
        expect(json['replace'], true);

        final decoded = ActivitySnapshotEvent.fromJson(json);
        expect(decoded.messageId, 'rag:abc123');
        expect(decoded.activityType, 'skill_tool_call');
        expect(decoded.content, content);
        expect(decoded.replace, true);
      });

      test('ActivitySnapshotEvent replace can be set to false', () {
        const event = ActivitySnapshotEvent(
          messageId: 'msg-1',
          activityType: 'test',
          content: {},
          replace: false,
        );
        expect(event.replace, false);

        final json = event.toJson();
        expect(json['replace'], false);

        final decoded = ActivitySnapshotEvent.fromJson(json);
        expect(decoded.replace, false);
      });

      test('ActivitySnapshotEvent fromJson with missing optional replace', () {
        final json = {
          'type': 'ACTIVITY_SNAPSHOT',
          'messageId': 'msg-1',
          'activityType': 'test',
          'content': {'key': 'value'},
        };

        final event = ActivitySnapshotEvent.fromJson(json);
        expect(event.messageId, 'msg-1');
        expect(event.activityType, 'test');
        expect(event.content, {'key': 'value'});
        expect(event.replace, true);
      });

      test('ActivitySnapshotEvent fromJson throws on missing messageId', () {
        final json = {
          'type': 'ACTIVITY_SNAPSHOT',
          'activityType': 'test',
          'content': {'key': 'value'},
        };

        expect(
          () => ActivitySnapshotEvent.fromJson(json),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ActivitySnapshotEvent fromJson throws on missing activityType', () {
        final json = {
          'type': 'ACTIVITY_SNAPSHOT',
          'messageId': 'msg-1',
          'content': {'key': 'value'},
        };

        expect(
          () => ActivitySnapshotEvent.fromJson(json),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ActivitySnapshotEvent fromJson throws on missing content', () {
        final json = {
          'type': 'ACTIVITY_SNAPSHOT',
          'messageId': 'msg-1',
          'activityType': 'test',
        };

        expect(
          () => ActivitySnapshotEvent.fromJson(json),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ActivitySnapshotEvent copyWith preserves unchanged fields', () {
        const event = ActivitySnapshotEvent(
          messageId: 'msg-1',
          activityType: 'test',
          content: {'a': 1},
          replace: false,
          timestamp: 1000,
        );

        final withMessageId = event.copyWith(messageId: 'msg-2');
        expect(withMessageId.messageId, 'msg-2');
        expect(withMessageId.activityType, 'test');
        expect(withMessageId.content, {'a': 1});
        expect(withMessageId.replace, false);
        expect(withMessageId.timestamp, 1000);

        final withActivityType = event.copyWith(activityType: 'updated');
        expect(withActivityType.messageId, 'msg-1');
        expect(withActivityType.activityType, 'updated');

        final withContent = event.copyWith(content: {'b': 2});
        expect(withContent.content, {'b': 2});
        expect(withContent.messageId, 'msg-1');

        final withReplace = event.copyWith(replace: true);
        expect(withReplace.replace, true);
        expect(withReplace.messageId, 'msg-1');

        final withTimestamp = event.copyWith(timestamp: 2000);
        expect(withTimestamp.timestamp, 2000);
        expect(withTimestamp.messageId, 'msg-1');
      });

      test('ActivitySnapshotEvent timestamp survives serialization', () {
        const event = ActivitySnapshotEvent(
          messageId: 'msg-1',
          activityType: 'test',
          content: {'key': 'value'},
          timestamp: 1710000000,
        );

        final json = event.toJson();
        expect(json['timestamp'], 1710000000);

        final decoded = ActivitySnapshotEvent.fromJson(json);
        expect(decoded.timestamp, 1710000000);
      });

      test('ActivitySnapshotEvent via BaseEvent.fromJson factory', () {
        final json = {
          'type': 'ACTIVITY_SNAPSHOT',
          'messageId': 'rag:abc123',
          'activityType': 'skill_tool_call',
          'content': {'skill': 'rag'},
          'replace': true,
        };

        final event = BaseEvent.fromJson(json);
        expect(event, isA<ActivitySnapshotEvent>());
        final activity = event as ActivitySnapshotEvent;
        expect(activity.messageId, 'rag:abc123');
        expect(activity.activityType, 'skill_tool_call');
      });
    });
  });
}