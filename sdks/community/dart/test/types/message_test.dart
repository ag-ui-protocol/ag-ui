import 'package:test/test.dart';
import 'package:ag_ui/ag_ui.dart';

void main() {
  group('Message Types', () {
    group('DeveloperMessage', () {
      test('should serialize and deserialize correctly', () {
        final message = DeveloperMessage(
          id: 'msg_001',
          content: 'This is a developer message',
          name: 'dev_system',
        );

        final json = message.toJson();
        expect(json['id'], 'msg_001');
        expect(json['role'], 'developer');
        expect(json['content'], 'This is a developer message');
        expect(json['name'], 'dev_system');

        final decoded = DeveloperMessage.fromJson(json);
        expect(decoded.id, message.id);
        expect(decoded.content, message.content);
        expect(decoded.name, message.name);
        expect(decoded.role, MessageRole.developer);
      });

      test('should handle missing optional fields', () {
        final json = {
          'id': 'msg_002',
          'role': 'developer',
          'content': 'Minimal developer message',
        };

        final message = DeveloperMessage.fromJson(json);
        expect(message.id, 'msg_002');
        expect(message.content, 'Minimal developer message');
        expect(message.name, isNull);
      });

      test('should throw on missing required fields', () {
        final json = {
          'id': 'msg_003',
          'role': 'developer',
        };

        expect(
          () => DeveloperMessage.fromJson(json),
          throwsA(isA<AGUIValidationError>()),
        );
      });
    });

    group('AssistantMessage', () {
      test('should handle tool calls', () {
        final message = AssistantMessage(
          id: 'asst_001',
          content: 'I will help you with that',
          toolCalls: [
            ToolCall(
              id: 'call_001',
              function: FunctionCall(
                name: 'get_weather',
                arguments: '{"location": "New York"}',
              ),
            ),
          ],
        );

        final json = message.toJson();
        expect(json['id'], 'asst_001');
        expect(json['role'], 'assistant');
        expect(json['content'], 'I will help you with that');
        expect(json['toolCalls'], isA<List>());
        expect(json['toolCalls']!.length, 1);

        final decoded = AssistantMessage.fromJson(json);
        expect(decoded.id, message.id);
        expect(decoded.content, message.content);
        expect(decoded.toolCalls?.length, 1);
        expect(decoded.toolCalls![0].id, 'call_001');
        expect(decoded.toolCalls![0].function.name, 'get_weather');
      });

      test('should handle both camelCase and snake_case tool calls', () {
        final snakeCaseJson = {
          'id': 'asst_002',
          'role': 'assistant',
          'tool_calls': [
            {
              'id': 'call_002',
              'type': 'function',
              'function': {
                'name': 'search',
                'arguments': '{"query": "AG-UI"}',
              },
            },
          ],
        };

        final message = AssistantMessage.fromJson(snakeCaseJson);
        expect(message.toolCalls?.length, 1);
        expect(message.toolCalls![0].id, 'call_002');
      });
    });

    group('ToolMessage', () {
      test('should handle error field', () {
        final message = ToolMessage(
          id: 'tool_001',
          content: 'Tool execution failed',
          toolCallId: 'call_001',
          error: 'Connection timeout',
        );

        final json = message.toJson();
        expect(json['error'], 'Connection timeout');

        final decoded = ToolMessage.fromJson(json);
        expect(decoded.error, 'Connection timeout');
      });

      test('should handle both camelCase and snake_case tool_call_id', () {
        final snakeCaseJson = {
          'id': 'tool_002',
          'role': 'tool',
          'content': 'Result',
          'tool_call_id': 'call_002',
        };

        final message = ToolMessage.fromJson(snakeCaseJson);
        expect(message.toolCallId, 'call_002');
      });
    });

    group('Message Factory', () {
      test('should create correct message type based on role', () {
        final messages = [
          {'id': '1', 'role': 'developer', 'content': 'Dev msg'},
          {'id': '2', 'role': 'system', 'content': 'System msg'},
          {'id': '3', 'role': 'user', 'content': 'User msg'},
          {'id': '4', 'role': 'assistant', 'content': 'Assistant msg'},
          {
            'id': '5',
            'role': 'tool',
            'content': 'Tool result',
            'toolCallId': 'call_001'
          },
        ];

        final decoded = messages.map((json) => Message.fromJson(json)).toList();

        expect(decoded[0], isA<DeveloperMessage>());
        expect(decoded[1], isA<SystemMessage>());
        expect(decoded[2], isA<UserMessage>());
        expect(decoded[3], isA<AssistantMessage>());
        expect(decoded[4], isA<ToolMessage>());
      });

      test('should throw on invalid role', () {
        final json = {
          'id': 'invalid_001',
          'role': 'invalid_role',
          'content': 'Some content',
        };

        expect(
          () => Message.fromJson(json),
          throwsA(isA<AGUIValidationError>()),
        );
      });
    });

    group('Unknown field tolerance', () {
      test('should ignore unknown fields in JSON', () {
        final json = {
          'id': 'msg_unknown',
          'role': 'user',
          'content': 'User message',
          'unknown_field': 'should be ignored',
          'another_unknown': {'nested': 'data'},
        };

        final message = UserMessage.fromJson(json);
        expect(message.id, 'msg_unknown');
        expect(message.content, 'User message');
        
        // Verify unknown fields are not included in serialized output
        final serialized = message.toJson();
        expect(serialized.containsKey('unknown_field'), false);
        expect(serialized.containsKey('another_unknown'), false);
      });
    });
  });
}