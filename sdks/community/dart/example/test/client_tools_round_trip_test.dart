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
  final List<List<Message>> requests = [];
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
    // The page mutates its history after events arrive. Capture the payload at
    // request time rather than retaining an alias to that growing list.
    requests.add(List<Message>.of(messages));
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
  test(
    'sending after disposal does not start a run or change history',
    () async {
      final service = FakeAgUiService([]);
      final state = ClientToolsPageState(
        endpoint: _clientToolsEndpoint(),
        service: service,
      );

      state.dispose();
      state.sendMessage('Too late.');
      await pumpEventQueue();

      expect(service.calls, 0);
      expect(state.messages, isEmpty);
      expect(state.busy, isFalse);
    },
  );

  test('second turn includes the completed streamed assistant reply', () async {
    final service = FakeAgUiService([
      [
        TextMessageStartEvent(messageId: 'answer_1'),
        TextMessageContentEvent(messageId: 'answer_1', delta: 'The answer '),
        TextMessageContentEvent(messageId: 'answer_1', delta: 'is 42.'),
        TextMessageEndEvent(messageId: 'answer_1'),
        _runFinished,
      ],
      [_runFinished],
    ]);
    final state = ClientToolsPageState(
      endpoint: _clientToolsEndpoint(),
      service: service,
    );
    addTearDown(state.dispose);

    state.sendMessage('What is the answer?');
    await pumpEventQueue();
    state.sendMessage('Explain that answer.');
    await pumpEventQueue();

    expect(service.calls, 2);
    expect(service.requests.first, hasLength(1));
    final followUp = service.requests[1];
    expect(followUp.map((m) => m.role), [
      MessageRole.user,
      MessageRole.assistant,
      MessageRole.user,
    ]);
    expect(followUp.map((m) => m.content), [
      'What is the answer?',
      'The answer is 42.',
      'Explain that answer.',
    ]);
    expect(followUp[1].id, 'answer_1');
    expect(state.busy, isFalse);
  });

  test('second turn includes a reply delivered as text chunks', () async {
    final service = FakeAgUiService([
      [
        TextMessageChunkEvent(messageId: 'answer_1', delta: 'Hello '),
        TextMessageChunkEvent(delta: 'again.'),
        _runFinished,
      ],
      [_runFinished],
    ]);
    final state = ClientToolsPageState(
      endpoint: _clientToolsEndpoint(),
      service: service,
    );
    addTearDown(state.dispose);

    state.sendMessage('Hello.');
    await pumpEventQueue();
    state.sendMessage('Continue.');
    await pumpEventQueue();

    final reply = service.requests[1].whereType<AssistantMessage>().single;
    expect(reply.id, 'answer_1');
    expect(reply.content, 'Hello again.');
    expect(service.requests[1], hasLength(3));
  });

  for (final explicitError in [false, true]) {
    test('a completed run does not retain an earlier interrupted fragment '
        '(RUN_ERROR: $explicitError)', () async {
      final service = FakeAgUiService([
        [
          TextMessageStartEvent(messageId: 'interrupted'),
          TextMessageContentEvent(
            messageId: 'interrupted',
            delta: 'Unfinished',
          ),
          if (explicitError) RunErrorEvent(message: 'Connection lost'),
          // No TEXT_MESSAGE_END or RUN_FINISHED.
        ],
        [
          TextMessageChunkEvent(
            messageId: 'completed',
            delta: 'Complete answer.',
          ),
          _runFinished,
        ],
        [_runFinished],
      ]);
      final state = ClientToolsPageState(
        endpoint: _clientToolsEndpoint(),
        service: service,
      );
      addTearDown(state.dispose);

      state.sendMessage('First question.');
      await pumpEventQueue();
      expect(state.busy, isFalse);
      state.sendMessage('Try again.');
      await pumpEventQueue();
      state.sendMessage('Continue.');
      await pumpEventQueue();

      expect(service.calls, 3);
      expect(service.requests[1].whereType<AssistantMessage>(), isEmpty);
      final finalHistory = service.requests[2];
      expect(finalHistory.map((m) => m.role), [
        MessageRole.user,
        MessageRole.user,
        MessageRole.assistant,
        MessageRole.user,
      ]);
      final reply = finalHistory.whereType<AssistantMessage>().single;
      expect(reply.id, 'completed');
      expect(reply.content, 'Complete answer.');
      expect(finalHistory.any((m) => m.id == 'interrupted'), isFalse);
    });
  }

  for (final streamFirst in [false, true]) {
    test('second turn retains snapshot replies without duplicates '
        '(streamed first: $streamFirst)', () async {
      final snapshot = MessagesSnapshotEvent(
        messages: [
          AssistantMessage(id: 'answer_1', content: 'The final answer is 42.'),
        ],
      );
      final service = FakeAgUiService([
        [
          if (streamFirst) ...[
            TextMessageStartEvent(messageId: 'answer_1'),
            TextMessageContentEvent(
              messageId: 'answer_1',
              delta: 'Draft answer',
            ),
          ],
          snapshot,
          snapshot,
          if (streamFirst) TextMessageEndEvent(messageId: 'answer_1'),
          _runFinished,
        ],
        [_runFinished],
      ]);
      final state = ClientToolsPageState(
        endpoint: _clientToolsEndpoint(),
        service: service,
      );
      addTearDown(state.dispose);

      state.sendMessage('What is the answer?');
      await pumpEventQueue();
      state.sendMessage('Explain that answer.');
      await pumpEventQueue();

      expect(service.calls, 2);
      final followUp = service.requests[1];
      expect(followUp.map((m) => m.role), [
        MessageRole.user,
        MessageRole.assistant,
        MessageRole.user,
      ]);
      final reply = followUp.whereType<AssistantMessage>().single;
      expect(reply.id, 'answer_1');
      expect(reply.content, 'The final answer is 42.');
      expect(followUp.whereType<ToolMessage>(), isEmpty);
    });
  }

  test(
    'second turn retains tool exchange and answer without replaying calls',
    () async {
      final proposal = AssistantMessage(
        id: 'proposal_1',
        content: 'Calculating now.',
        toolCalls: [
          ToolCall(
            id: 'c1',
            function: FunctionCall(
              name: 'calculate',
              arguments: '{"expression":"6*7"}',
            ),
          ),
        ],
      );
      final echoedResult = ToolMessage(
        id: 'echo_c1',
        toolCallId: 'c1',
        content: '{"result":42}',
      );
      final service = FakeAgUiService([
        [
          TextMessageStartEvent(messageId: 'proposal_1'),
          TextMessageContentEvent(
            messageId: 'proposal_1',
            delta: 'Calculating now.',
          ),
          TextMessageEndEvent(messageId: 'proposal_1'),
          MessagesSnapshotEvent(messages: [proposal]),
          _runFinished,
        ],
        [
          TextMessageStartEvent(messageId: 'answer_1'),
          TextMessageContentEvent(messageId: 'answer_1', delta: '6*7 = 42'),
          TextMessageEndEvent(messageId: 'answer_1'),
          MessagesSnapshotEvent(
            messages: [
              proposal,
              echoedResult,
              AssistantMessage(id: 'answer_1', content: '6*7 = 42'),
            ],
          ),
          _runFinished,
        ],
        // A cumulative snapshot may repeat the old proposal as its last assistant
        // message. The already-recorded tool result must prevent a second execution.
        [
          MessagesSnapshotEvent(messages: [proposal, echoedResult]),
          _runFinished,
        ],
      ]);
      final state = ClientToolsPageState(
        endpoint: _clientToolsEndpoint(),
        service: service,
      );
      addTearDown(state.dispose);

      state.sendMessage('What is 6*7?');
      await pumpEventQueue();
      expect(service.calls, 2);
      expect(service.requests[1].map((m) => m.role), [
        MessageRole.user,
        MessageRole.assistant,
        MessageRole.tool,
      ]);

      state.sendMessage('Use that answer.');
      await pumpEventQueue();

      expect(
        service.calls,
        3,
        reason: 'the old call must not trigger another run',
      );
      final followUp = service.requests[2];
      expect(followUp.map((m) => m.role), [
        MessageRole.user,
        MessageRole.assistant,
        MessageRole.tool,
        MessageRole.assistant,
        MessageRole.user,
      ]);
      expect(followUp[1].id, 'proposal_1');
      expect((followUp[1] as AssistantMessage).toolCalls!.single.id, 'c1');
      expect(followUp.whereType<ToolMessage>().single.toolCallId, 'c1');
      expect(followUp[3].id, 'answer_1');
      expect(followUp[3].content, '6*7 = 42');
      expect(_countType(state.messages, ChatMessageType.tool), 1);
      expect(state.busy, isFalse);
    },
  );

  test(
    'a text-only snapshot clears a superseded pending tool proposal',
    () async {
      final service = FakeAgUiService([
        [
          _snapshotWithToolCall('c1', '6*7'),
          MessagesSnapshotEvent(
            messages: [
              AssistantMessage(id: 'answer_1', content: 'No tool is needed.'),
            ],
          ),
          _runFinished,
        ],
        [_runFinished],
      ]);
      final state = ClientToolsPageState(
        endpoint: _clientToolsEndpoint(),
        service: service,
      );
      addTearDown(state.dispose);

      state.sendMessage('Answer me.');
      await pumpEventQueue();
      state.sendMessage('Continue.');
      await pumpEventQueue();

      expect(service.calls, 2);
      expect(service.requests[1].whereType<ToolMessage>(), isEmpty);
      final reply = service.requests[1].whereType<AssistantMessage>().single;
      expect(reply.content, 'No tool is needed.');
      expect(reply.toolCalls, isNull);
      expect(_countType(state.messages, ChatMessageType.tool), 0);
    },
  );

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
