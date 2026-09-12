import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ag_ui/ag_ui.dart';
import 'package:ag_ui_example/models/chat_message.dart';
import 'package:ag_ui_example/models/endpoint_config.dart';
import 'package:ag_ui_example/services/ag_ui_service.dart';
import 'package:ag_ui_example/pages/client_tools_page.dart';

/// A fake service that yields a scripted list of events per `run()` call, so the
/// round-trip loop can be driven deterministically without a server.
class FakeAgUiService extends AgUiService {
  final List<List<BaseEvent>> runs;
  int calls = 0;
  FakeAgUiService(this.runs);

  @override
  Stream<BaseEvent> run(
    String endpoint, {
    required String threadId,
    required List<Message> messages,
    List<Tool> tools = const [],
    dynamic state,
    Map<String, String> extraQuery = const {},
  }) async* {
    final events = calls < runs.length ? runs[calls] : const <BaseEvent>[];
    calls++;
    for (final e in events) {
      yield e;
    }
  }
}

EndpointConfig _clientToolsEndpoint() => const EndpointConfig(
      name: 'Agentic Chat',
      path: 'agentic_chat',
      description: 'test',
      icon: Icons.chat,
      featureKind: FeatureKind.clientTools,
      tools: [
        Tool(
          name: 'calculate',
          description: 'calc',
          parameters: {
            'type': 'object',
            'properties': {
              'expression': {'type': 'string'}
            },
          },
        ),
      ],
    );

MessagesSnapshotEvent _snapshotWithToolCall(String callId, String expr) =>
    MessagesSnapshotEvent(messages: [
      AssistantMessage(id: 'a_$callId', toolCalls: [
        ToolCall(
          id: callId,
          function: FunctionCall(
            name: 'calculate',
            arguments: '{"expression":"$expr"}',
          ),
        ),
      ]),
    ]);

final _runFinished = RunFinishedEvent(threadId: 't', runId: 'r');

int _countType(List<ChatMessage> ms, ChatMessageType t) =>
    ms.where((m) => m.type == t).length;

void main() {
  test('happy round-trip: tool call → result → final answer; busy clears', () async {
    final service = FakeAgUiService([
      // Run A: model calls calculate, then finishes.
      [_snapshotWithToolCall('c1', '6*7'), _runFinished],
      // Run B: model answers in prose, then finishes.
      [
        TextMessageStartEvent(messageId: 'm1'),
        TextMessageContentEvent(messageId: 'm1', delta: '6*7 = 42'),
        TextMessageEndEvent(messageId: 'm1'),
        _runFinished,
      ],
    ]);
    final state = ClientToolsPageState(
        endpoint: _clientToolsEndpoint(), service: service);

    state.sendMessage('what is 6*7?');
    await pumpEventQueue();

    expect(service.calls, 2, reason: 'should re-run once after the tool result');
    expect(state.busy, isFalse, reason: 'exchange converged');
    // A tool bubble was rendered (agentic_chat visibility) and the final text shown.
    expect(_countType(state.messages, ChatMessageType.tool), 1);
    final assistantTexts = state.messages
        .where((m) => m.type == ChatMessageType.assistant)
        .map((m) => m.content)
        .join();
    expect(assistantTexts, contains('42'));
    final toolBubble =
        state.messages.firstWhere((m) => m.type == ChatMessageType.tool);
    expect(toolBubble.content, contains('42'),
        reason: 'calculate(6*7) result is 42');
  });

  test('reasoning is deduped across cumulative snapshots', () async {
    final reasoning = ReasoningMessage(id: 'r1', content: 'let me think');
    final service = FakeAgUiService([
      // Run A: snapshot carries reasoning + a tool call.
      [
        MessagesSnapshotEvent(messages: [
          reasoning,
          AssistantMessage(id: 'a1', toolCalls: [
            ToolCall(
                id: 'c1',
                function:
                    FunctionCall(name: 'calculate', arguments: '{"expression":"1+1"}')),
          ]),
        ]),
        _runFinished,
      ],
      // Run B: cumulative snapshot re-includes the SAME reasoning id + final answer.
      [
        MessagesSnapshotEvent(messages: [
          reasoning,
          AssistantMessage(id: 'a2', content: 'done'),
        ]),
        _runFinished,
      ],
    ]);
    final state = ClientToolsPageState(
        endpoint: _clientToolsEndpoint(), service: service);

    state.sendMessage('compute 1+1');
    await pumpEventQueue();

    expect(_countType(state.messages, ChatMessageType.reasoning), 1,
        reason: 'same reasoning id must not be re-appended each round');
  });

  test('RUN_ERROR mid-resolve does not launch a second resolve loop', () async {
    final service = FakeAgUiService([
      // Run A: a tool call → finish (launches the resolve loop).
      [_snapshotWithToolCall('c1', '2+2'), _runFinished],
      // Run B: errors, THEN the server (hypothetically) sends another tool call +
      // finish on the same stream. The loop must abort and ignore the trailing events.
      [
        RunErrorEvent(message: 'boom'),
        _snapshotWithToolCall('c2', '9+9'),
        _runFinished,
      ],
    ]);
    final state = ClientToolsPageState(
        endpoint: _clientToolsEndpoint(), service: service);

    state.sendMessage('go');
    await pumpEventQueue();

    expect(state.busy, isFalse, reason: 'aborted run must clear busy');
    // Only c1 executed; c2 (post-error) must NOT have produced a second tool bubble.
    expect(_countType(state.messages, ChatMessageType.tool), 1,
        reason: 'post-error tool call must not be resolved');
    expect(
      state.messages.any((m) =>
          m.type == ChatMessageType.system && m.content.contains('Run error')),
      isTrue,
    );
  });

  test('dispose during a pending approval unwinds without throwing', () async {
    final approvalEndpoint = const EndpointConfig(
      name: 'HITL',
      path: 'human_in_the_loop',
      description: 'test',
      icon: Icons.person,
      featureKind: FeatureKind.approval,
      tools: [
        Tool(
          name: 'request_approval',
          description: 'approve',
          parameters: {
            'type': 'object',
            'properties': {
              'summary': {'type': 'string'},
              'action': {'type': 'string'}
            },
          },
        ),
      ],
    );
    final service = FakeAgUiService([
      [
        MessagesSnapshotEvent(messages: [
          AssistantMessage(id: 'a1', toolCalls: [
            ToolCall(
              id: 'c1',
              function: FunctionCall(
                  name: 'request_approval',
                  arguments: '{"summary":"Delete it","action":"delete_file"}'),
            ),
          ]),
        ]),
        _runFinished,
      ],
    ]);
    final state =
        ClientToolsPageState(endpoint: approvalEndpoint, service: service);

    state.sendMessage('delete the file');
    await pumpEventQueue();

    // The resolve loop is now awaiting the approval decision.
    expect(state.pendingApproval, isNotNull);

    // Disposing must complete the pending completer (false) and not throw.
    expect(() => state.dispose(), returnsNormally);
    await pumpEventQueue();
  });
}
