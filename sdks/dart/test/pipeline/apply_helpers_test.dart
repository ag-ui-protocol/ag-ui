import 'package:agui/agui.dart';
import 'package:agui/src/pipeline/apply.dart';
import 'package:test/test.dart';

/// The reducer's copy helpers are hand-written per message class, so a field
/// the schema adds later would compile and then be dropped on every delta.
/// These tests build every class with EVERY field set and check that each
/// helper keeps all of them: the guard between the generated types and the
/// hand-written copies.
void main() {
  const metadata = {'k': 'v'};
  const call = ToolCall(
    id: 'c',
    function: FunctionCall(name: 'f', arguments: '{}'),
    encryptedValue: 'enc',
    metadata: metadata,
  );
  final fullMessages = <Message>[
    const DeveloperMessage(
      subagentRunId: 's',
      id: 'd',
      name: 'n',
      encryptedValue: 'e',
      metadata: metadata,
      content: 'c',
    ),
    const SystemMessage(
      subagentRunId: 's',
      id: 'sy',
      name: 'n',
      encryptedValue: 'e',
      metadata: metadata,
      content: 'c',
    ),
    const AssistantMessage(
      subagentRunId: 's',
      id: 'a',
      name: 'n',
      encryptedValue: 'e',
      metadata: metadata,
      content: 'c',
      toolCalls: [call],
    ),
    const UserMessage(
      subagentRunId: 's',
      id: 'u',
      name: 'n',
      encryptedValue: 'e',
      metadata: metadata,
      content: 'c',
    ),
    const ToolMessage(
      subagentRunId: 's',
      id: 't',
      content: 'c',
      toolCallId: 'c',
      error: 'boom',
      encryptedValue: 'e',
      metadata: metadata,
    ),
    const ActivityMessage(
      subagentRunId: 's',
      id: 'act',
      activityType: 'x',
      content: {'a': 1},
      metadata: metadata,
    ),
    const ReasoningMessage(
      subagentRunId: 's',
      id: 'r',
      content: 'c',
      encryptedValue: 'e',
      metadata: metadata,
    ),
  ];

  /// Every key of the generated constructor is set above, so the JSON of a
  /// full message is the complete field list; a new schema field would show
  /// up here as a key the helper's output lacks.
  void expectAllFieldsKept(Message original, Message copy, String changed) {
    final before = original.toJson()..remove(changed);
    final after = copy.toJson()..remove(changed);
    expect(after, before, reason: '${original.runtimeType} lost a field');
  }

  for (final message in fullMessages) {
    group(message.runtimeType.toString(), () {
      test('withMetadata keeps every other field', () {
        expectAllFieldsKept(
          message,
          withMetadata(message, const {'k': 'w'}),
          'metadata',
        );
      });
      if (message is! ActivityMessage) {
        test('withContent keeps every other field', () {
          expectAllFieldsKept(message, withContent(message, 'new'), 'content');
        });
        test('withEncryptedValue keeps every other field', () {
          expectAllFieldsKept(
            message,
            withEncryptedValue(message, 'new'),
            'encryptedValue',
          );
        });
      }
    });
  }

  test('withToolCalls keeps every other assistant field', () {
    final assistant = fullMessages[2] as AssistantMessage;
    expectAllFieldsKept(
      assistant,
      withToolCalls(assistant, const []),
      'toolCalls',
    );
  });

  test('toolCallWith keeps every other tool call field', () {
    final before = call.toJson();
    expect(toolCallWith(call, arguments: '{"a":1}').toJson(), {
      ...before,
      'function': {'name': 'f', 'arguments': '{"a":1}'},
    });
    expect(toolCallWith(call, metadata: const {'z': 1}).toJson(), {
      ...before,
      'metadata': {'z': 1},
    });
    expect(toolCallWith(call, encryptedValue: 'x').toJson(), {
      ...before,
      'encryptedValue': 'x',
    });
  });
}
