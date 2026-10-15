import 'package:agui/agui.dart';
import 'package:agui/src/pipeline/verify.dart';
import 'package:test/test.dart';

// Wire-JSON builders. `sub` is the optional subagentRunId attribution tag.
typedef Json = Map<String, Object?>;

Json _tagged(Json json, String? sub) =>
    sub == null ? json : {...json, 'subagentRunId': sub};

Json runStarted([String runId = 'r1', Json? input]) => {
  'type': 'RUN_STARTED',
  'threadId': 't',
  'runId': runId,
  if (input != null) 'input': input,
};
Json runFinished([String runId = 'r1']) => {
  'type': 'RUN_FINISHED',
  'threadId': 't',
  'runId': runId,
};
Json runError([String message = 'boom']) => {
  'type': 'RUN_ERROR',
  'message': message,
};
Json textStart(String id, {String? sub}) =>
    _tagged({'type': 'TEXT_MESSAGE_START', 'messageId': id}, sub);
Json textContent(String id, {String? sub}) => _tagged({
  'type': 'TEXT_MESSAGE_CONTENT',
  'messageId': id,
  'delta': 'hi',
}, sub);
Json textEnd(String id, {String? sub}) =>
    _tagged({'type': 'TEXT_MESSAGE_END', 'messageId': id}, sub);
Json toolStart(String id, {String? parent, String? sub}) => _tagged({
  'type': 'TOOL_CALL_START',
  'toolCallId': id,
  'toolCallName': 'search',
  if (parent != null) 'parentMessageId': parent,
}, sub);
Json toolArgs(String id, {String? sub}) =>
    _tagged({'type': 'TOOL_CALL_ARGS', 'toolCallId': id, 'delta': '{}'}, sub);
Json toolEnd(String id, {String? sub}) =>
    _tagged({'type': 'TOOL_CALL_END', 'toolCallId': id}, sub);
Json toolResult(String messageId, String toolCallId, {String? sub}) => _tagged({
  'type': 'TOOL_CALL_RESULT',
  'messageId': messageId,
  'toolCallId': toolCallId,
  'content': 'ok',
}, sub);
Json stepStarted(String name, {String? sub}) =>
    _tagged({'type': 'STEP_STARTED', 'stepName': name}, sub);
Json stepFinished(String name, {String? sub}) =>
    _tagged({'type': 'STEP_FINISHED', 'stepName': name}, sub);
Json reasoningStart(String id, {String? sub}) =>
    _tagged({'type': 'REASONING_START', 'messageId': id}, sub);
Json reasoningEnd(String id, {String? sub}) =>
    _tagged({'type': 'REASONING_END', 'messageId': id}, sub);
Json reasoningMessageStart(String id, {String? sub}) => _tagged({
  'type': 'REASONING_MESSAGE_START',
  'messageId': id,
  'role': 'reasoning',
}, sub);
Json reasoningMessageContent(String id, {String? sub}) => _tagged({
  'type': 'REASONING_MESSAGE_CONTENT',
  'messageId': id,
  'delta': 'thinking',
}, sub);
Json reasoningMessageEnd(String id, {String? sub}) =>
    _tagged({'type': 'REASONING_MESSAGE_END', 'messageId': id}, sub);
Json encrypted(String subtype, String entityId, {String? sub}) => _tagged({
  'type': 'REASONING_ENCRYPTED_VALUE',
  'subtype': subtype,
  'entityId': entityId,
  'encryptedValue': 'opaque',
}, sub);
Json activitySnapshot(String id, {String? sub, bool? replace}) => _tagged({
  'type': 'ACTIVITY_SNAPSHOT',
  'messageId': id,
  'activityType': 'plan',
  'content': <String, Object?>{},
  if (replace != null) 'replace': replace,
}, sub);
Json activityDelta(String id, {String? sub}) => _tagged({
  'type': 'ACTIVITY_DELTA',
  'messageId': id,
  'activityType': 'plan',
  'patch': <Object?>[],
}, sub);
Json subStarted(String id, {String? parent}) => {
  'type': 'SUBAGENT_STARTED',
  'subagentRunId': id,
  'name': 'researcher',
  if (parent != null) 'parentSubagentRunId': parent,
};
Json subFinished(String id) => {
  'type': 'SUBAGENT_FINISHED',
  'subagentRunId': id,
};
Json subError(String id) => {
  'type': 'SUBAGENT_ERROR',
  'subagentRunId': id,
  'message': 'failed',
};
Json messagesSnapshot(List<Json> messages) => {
  'type': 'MESSAGES_SNAPSHOT',
  'messages': messages,
};
Json assistant(String id, {String? sub, List<String> toolCalls = const []}) =>
    _tagged({
      'id': id,
      'role': 'assistant',
      'content': 'hi',
      if (toolCalls.isNotEmpty)
        'toolCalls': [
          for (final tc in toolCalls)
            {
              'id': tc,
              'type': 'function',
              'function': {'name': 'search', 'arguments': '{}'},
            },
        ],
    }, sub);
Json runInput(List<Json> messages) => {
  'threadId': 't',
  'runId': 'r1',
  'messages': messages,
};

Stream<Event> _stream(List<Json> raw) =>
    Stream.fromIterable(raw.map(Event.fromJson));

/// Runs [raw] through the verifier, expecting it to pass unchanged and to emit
/// no warning.
Future<void> expectPasses(List<Json> raw) async {
  final warnings = <String>[];
  final out = await verifyEvents(_stream(raw), warnings.add).toList();
  expect(
    out.map((e) => e.toJson()).toList(),
    raw.map((j) => Event.fromJson(j).toJson()).toList(),
  );
  expect(warnings, isEmpty);
}

/// Runs [raw] through the verifier, expecting an [AguiProtocolException]
/// whose message contains every one of [fragments].
Future<void> expectFails(List<Json> raw, List<String> fragments) => expectLater(
  verifyEvents(_stream(raw), ignoreWarnings).toList(),
  throwsA(
    isA<AguiProtocolException>().having(
      (e) => e.message,
      'message',
      allOf([for (final f in fragments) contains(f)]),
    ),
  ),
);

void main() {
  group('lifecycle', () {
    test('a conformant stream passes through unchanged with no warning', () {
      return expectPasses([
        runStarted(),
        stepStarted('plan'),
        textStart('m1'),
        textContent('m1'),
        textEnd('m1'),
        toolStart('tc1', parent: 'm1'),
        toolArgs('tc1'),
        toolEnd('tc1'),
        toolResult('m2', 'tc1'),
        reasoningStart('r1'),
        reasoningMessageStart('r1'),
        reasoningMessageContent('r1'),
        reasoningMessageEnd('r1'),
        reasoningEnd('r1'),
        {
          'type': 'STATE_SNAPSHOT',
          'snapshot': {'a': 1},
        },
        {'type': 'STATE_DELTA', 'delta': <Object?>[]},
        {'type': 'CUSTOM', 'name': 'x', 'value': 1},
        {'type': 'RAW', 'event': 'anything'},
        activitySnapshot('a1'),
        activityDelta('a1'),
        stepFinished('plan'),
        runFinished(),
      ]);
    });

    test('the first event must be RUN_STARTED', () {
      return expectFails(
        [textStart('m1')],
        ["First event must be 'RUN_STARTED'"],
      );
    });

    test('RUN_ERROR is accepted as the first event', () {
      return expectPasses([runError()]);
    });

    test('a second RUN_STARTED while a run is active is rejected', () {
      return expectFails(
        [runStarted(), runStarted('r2')],
        ["Cannot send 'RUN_STARTED' while a run is still active"],
      );
    });

    test('events after RUN_FINISHED are rejected', () {
      return expectFails(
        [runStarted(), runFinished(), textStart('m1')],
        [
          "Cannot send event type 'TEXT_MESSAGE_START'",
          "The run has already finished with 'RUN_FINISHED'",
        ],
      );
    });

    test('RUN_ERROR after RUN_FINISHED is accepted', () {
      return expectPasses([runStarted(), runFinished(), runError()]);
    });

    test('events after RUN_ERROR within the same run are rejected', () async {
      final delivered = <Event>[];
      await expectLater(
        verifyEvents(
          _stream([runStarted(), runError(), textStart('m1')]),
          ignoreWarnings,
        ).forEach(delivered.add),
        throwsA(
          isA<AguiProtocolException>().having(
            (e) => e.message,
            'message',
            contains("The run has already errored with 'RUN_ERROR'"),
          ),
        ),
      );
      // RUN_ERROR itself is delivered before the stream fails.
      expect(delivered.map((e) => e.type), [
        EventType.runStarted,
        EventType.runError,
      ]);
    });

    test('a second RUN_ERROR in the same run is rejected', () {
      return expectFails(
        [runStarted(), runError(), runError()],
        ["Cannot send event type 'RUN_ERROR'", 'already errored'],
      );
    });
  });

  group('multiple runs', () {
    test('two sequential runs pass', () {
      return expectPasses([
        runStarted('r1'),
        textStart('m1'),
        textEnd('m1'),
        runFinished('r1'),
        runStarted('r2'),
        textStart('m2'),
        textEnd('m2'),
        runFinished('r2'),
      ]);
    });

    test('three sequential runs reuse ids, tool calls and steps', () {
      return expectPasses([
        for (final r in ['r1', 'r2', 'r3']) ...[
          runStarted(r),
          stepStarted('s'),
          textStart('m1'),
          textEnd('m1'),
          toolStart('tc1'),
          toolEnd('tc1'),
          stepFinished('s'),
          runFinished(r),
        ],
      ]);
    });

    test('RUN_ERROR then a new RUN_STARTED begins a new run', () {
      return expectPasses([
        runStarted('r1'),
        textStart('m1'),
        runError(),
        runStarted('r2'),
        // m1 was left open by the errored run; the new run starts clean.
        textStart('m1'),
        textEnd('m1'),
        runFinished('r2'),
      ]);
    });

    test('RUN_ERROR as the first event, then a run', () {
      return expectPasses([runError(), runStarted(), runFinished()]);
    });

    test('a replayed thread with an errored middle run keeps later runs', () {
      return expectPasses([
        runStarted('r1'),
        runFinished('r1'),
        runStarted('r2'),
        runError(),
        runStarted('r3'),
        runFinished('r3'),
      ]);
    });

    test('a new run resets open steps, subagents and retained owners', () {
      return expectPasses([
        runStarted('r1'),
        stepStarted('s'),
        subStarted('s1'),
        textStart('m1', sub: 's1'),
        textEnd('m1', sub: 's1'),
        runError(),
        runStarted('r2'),
        // Same step name, same subagent id and m1 under a different owner:
        // all legal because the per-run tracking was reset.
        stepStarted('s'),
        subStarted('s1'),
        subFinished('s1'),
        textStart('m1', sub: 's2'),
        textEnd('m1', sub: 's2'),
        stepFinished('s'),
        runFinished('r2'),
      ]);
    });
  });

  group('text messages', () {
    test('a duplicate TEXT_MESSAGE_START is rejected', () {
      return expectFails(
        [runStarted(), textStart('m1'), textStart('m1')],
        [
          "Cannot send 'TEXT_MESSAGE_START' event: A text message with ID "
              "'m1' is already in progress",
        ],
      );
    });

    test('content for an unknown id is rejected', () {
      return expectFails(
        [runStarted(), textStart('m1'), textContent('m2')],
        [
          "Cannot send 'TEXT_MESSAGE_CONTENT' event",
          "No active text message found with ID 'm2'",
        ],
      );
    });

    test('ending a message that was not started is rejected', () {
      return expectFails(
        [runStarted(), textEnd('m1')],
        [
          "Cannot send 'TEXT_MESSAGE_END' event",
          "No active text message found with ID 'm1'",
        ],
      );
    });

    test('content after the message ended is rejected', () {
      return expectFails(
        [runStarted(), textStart('m1'), textEnd('m1'), textContent('m1')],
        ["No active text message found with ID 'm1'"],
      );
    });

    test('RUN_FINISHED with an open text message is rejected', () {
      return expectFails(
        [runStarted(), textStart('m1'), textStart('m2'), runFinished()],
        [
          "Cannot send 'RUN_FINISHED' while text messages are still active: "
              'm1, m2',
        ],
      );
    });

    test('interleaved messages are allowed', () {
      return expectPasses([
        runStarted(),
        textStart('m1'),
        textStart('m2'),
        textContent('m1'),
        textContent('m2'),
        textEnd('m2'),
        textEnd('m1'),
        runFinished(),
      ]);
    });
  });

  group('tool calls', () {
    test('a duplicate TOOL_CALL_START is rejected', () {
      return expectFails(
        [runStarted(), toolStart('tc1'), toolStart('tc1')],
        [
          "Cannot send 'TOOL_CALL_START' event: A tool call with ID 'tc1' is "
              'already in progress',
        ],
      );
    });

    test('args for an unknown id are rejected', () {
      return expectFails(
        [runStarted(), toolStart('tc1'), toolArgs('tc2')],
        [
          "Cannot send 'TOOL_CALL_ARGS' event",
          "No active tool call found with ID 'tc2'",
        ],
      );
    });

    test('ending a tool call that was not started is rejected', () {
      return expectFails(
        [runStarted(), toolEnd('tc1')],
        [
          "Cannot send 'TOOL_CALL_END' event",
          "No active tool call found with ID 'tc1'",
        ],
      );
    });

    test('RUN_FINISHED with an open tool call is rejected', () {
      return expectFails(
        [runStarted(), toolStart('tc1'), runFinished()],
        ["Cannot send 'RUN_FINISHED' while tool calls are still active: tc1"],
      );
    });
  });

  group('steps', () {
    test('finishing a step that was not started is rejected', () {
      return expectFails(
        [runStarted(), stepFinished('plan')],
        ["Cannot send 'STEP_FINISHED' for step \"plan\" that was not started"],
      );
    });

    test('finishing a step with a different name is rejected', () {
      return expectFails(
        [runStarted(), stepStarted('a'), stepFinished('b')],
        ['that was not started'],
      );
    });

    test('starting an already active step is rejected', () {
      return expectFails(
        [runStarted(), stepStarted('plan'), stepStarted('plan')],
        ['Step "plan" is already active for \'STEP_STARTED\''],
      );
    });

    test('the duplicate-step message names the subagent', () {
      return expectFails(
        [
          runStarted(),
          stepStarted('plan', sub: 's1'),
          stepStarted('plan', sub: 's1'),
        ],
        ["Step \"plan\" is already active for 'STEP_STARTED' in subagent 's1'"],
      );
    });

    test('RUN_FINISHED with open steps lists them with their owners', () {
      return expectFails(
        [
          runStarted(),
          stepStarted('a'),
          stepStarted('b', sub: 's1'),
          runFinished(),
        ],
        [
          "Cannot send 'RUN_FINISHED' while steps are still active: "
              "a, b (subagent 's1')",
        ],
      );
    });

    test('nested steps and same-named steps under different owners pass', () {
      return expectPasses([
        runStarted(),
        stepStarted('outer'),
        stepStarted('tools'),
        stepStarted('tools', sub: 's1'),
        stepFinished('tools', sub: 's1'),
        stepFinished('tools'),
        stepFinished('outer'),
        runFinished(),
      ]);
    });

    test('closing the parent step under a subagent tag is rejected', () {
      return expectFails(
        [runStarted(), stepStarted('tools'), stepFinished('tools', sub: 's1')],
        [
          "Cannot send 'STEP_FINISHED' for step \"tools\" attributed to "
              "subagent 's1': that step is open under the parent agent. A "
              'step must be finished by whoever started it.',
        ],
      );
    });

    test('closing a subagent step untagged is rejected', () {
      return expectFails(
        [runStarted(), stepStarted('tools', sub: 's1'), stepFinished('tools')],
        [
          'attributed to the parent agent: that step is open under subagent '
              "'s1'",
        ],
      );
    });

    test('the empty string is a subagent id distinct from the parent', () {
      return expectFails(
        [runStarted(), stepStarted('tools'), stepFinished('tools', sub: '')],
        ["attributed to subagent '': that step is open under the parent"],
      );
    });
  });

  group('reasoning', () {
    test('a duplicate REASONING_START is rejected', () {
      return expectFails(
        [runStarted(), reasoningStart('r1'), reasoningStart('r1')],
        [
          "Cannot send 'REASONING_START' event: A reasoning span with ID 'r1' "
              'is already in progress',
        ],
      );
    });

    test('a duplicate REASONING_MESSAGE_START is rejected', () {
      return expectFails(
        [
          runStarted(),
          reasoningMessageStart('r1'),
          reasoningMessageStart('r1'),
        ],
        [
          "Cannot send 'REASONING_MESSAGE_START' event: A reasoning message "
              "with ID 'r1' is already in progress",
        ],
      );
    });

    test('content without an open reasoning message is rejected', () {
      return expectFails(
        [runStarted(), reasoningStart('r1'), reasoningMessageContent('r1')],
        [
          "Cannot send 'REASONING_MESSAGE_CONTENT' event",
          "No active reasoning message found with ID 'r1'",
        ],
      );
    });

    test('REASONING_MESSAGE_END without an opener is rejected', () {
      return expectFails(
        [runStarted(), reasoningMessageEnd('r1')],
        [
          "Cannot send 'REASONING_MESSAGE_END' event",
          "No active reasoning message found with ID 'r1'",
        ],
      );
    });

    test('REASONING_END without a span is rejected', () {
      return expectFails(
        [runStarted(), reasoningMessageStart('r1'), reasoningEnd('r1')],
        [
          "Cannot send 'REASONING_END' event: No active reasoning span found "
              "with ID 'r1'",
        ],
      );
    });

    test('RUN_FINISHED with an open reasoning message is rejected', () {
      return expectFails(
        [runStarted(), reasoningMessageStart('r1'), runFinished()],
        [
          "Cannot send 'RUN_FINISHED' while reasoning messages are still "
              'active: r1',
        ],
      );
    });

    test('RUN_FINISHED with an open reasoning span is rejected', () {
      return expectFails(
        [runStarted(), reasoningStart('r1'), runFinished()],
        [
          "Cannot send 'RUN_FINISHED' while reasoning spans are still active: "
              'r1',
        ],
      );
    });

    test('a span and a message may share an id', () {
      return expectPasses([
        runStarted(),
        reasoningStart('x', sub: 's1'),
        reasoningMessageStart('x'),
        reasoningMessageContent('x', sub: 's1'),
        reasoningMessageEnd('x'),
        reasoningEnd('x'),
        runFinished(),
      ]);
    });
  });

  group('subagent lifecycle', () {
    test('a well-formed lifecycle passes', () {
      return expectPasses([
        runStarted(),
        subStarted('s1'),
        subStarted('s2', parent: 's1'),
        textStart('m1', sub: 's2'),
        textEnd('m1', sub: 's2'),
        subError('s2'),
        subFinished('s1'),
        runFinished(),
      ]);
    });

    test('a duplicate SUBAGENT_STARTED is rejected', () {
      return expectFails(
        [runStarted(), subStarted('s1'), subStarted('s1')],
        [
          "Cannot send 'SUBAGENT_STARTED': subagent 's1' is already active. "
              "Finish it with 'SUBAGENT_FINISHED' first.",
        ],
      );
    });

    test('restarting a finished subagent in the same run is rejected', () {
      return expectFails(
        [runStarted(), subStarted('s1'), subFinished('s1'), subStarted('s1')],
        [
          "Cannot send 'SUBAGENT_STARTED': subagent 's1' has already finished "
              'in this run',
        ],
      );
    });

    test('an unknown parentSubagentRunId is rejected', () {
      return expectFails(
        [runStarted(), subStarted('s2', parent: 's1')],
        [
          "Cannot send 'SUBAGENT_STARTED': parentSubagentRunId 's1' has not "
              'been started in this run.',
        ],
      );
    });

    test('a child whose parent already finished is allowed', () {
      return expectPasses([
        runStarted(),
        subStarted('s1'),
        subFinished('s1'),
        subStarted('s2', parent: 's1'),
        subFinished('s2'),
        runFinished(),
      ]);
    });

    test('SUBAGENT_FINISHED for an id never started is rejected', () {
      return expectFails(
        [runStarted(), subFinished('s1')],
        [
          "Cannot send 'SUBAGENT_FINISHED': no active subagent found with ID "
              "'s1'",
        ],
      );
    });

    test('a second terminal for the same subagent is rejected', () {
      return expectFails(
        [runStarted(), subStarted('s1'), subFinished('s1'), subError('s1')],
        ["Cannot send 'SUBAGENT_ERROR': no active subagent found with ID 's1'"],
      );
    });

    test('RUN_FINISHED with an open subagent is rejected', () {
      return expectFails(
        [runStarted(), subStarted('s1'), runFinished()],
        ["Cannot send 'RUN_FINISHED' while subagents are still active: s1"],
      );
    });

    test('an event tagged with a finished subagent is not rejected', () {
      return expectPasses([
        runStarted(),
        subStarted('s1'),
        subFinished('s1'),
        {'type': 'CUSTOM', 'name': 'x', 'value': 1, 'subagentRunId': 's1'},
        runFinished(),
      ]);
    });

    test('an attribution-only stream with no lifecycle events passes', () {
      return expectPasses([
        runStarted(),
        textStart('m1', sub: 'never-started'),
        textContent('m1', sub: 'never-started'),
        textEnd('m1'),
        {
          'type': 'STATE_SNAPSHOT',
          'snapshot': <String, Object?>{},
          'subagentRunId': 's9',
        },
        runFinished(),
      ]);
    });

    test('SUBAGENT_STARTED without a name never reaches the verifier', () {
      // The TypeScript verifier rejects this itself, for in-process producers
      // that bypass its schema; here `name` is non-nullable and the decoder
      // rejects the event first.
      expect(
        () =>
            Event.fromJson({'type': 'SUBAGENT_STARTED', 'subagentRunId': 's1'}),
        throwsA(isA<AguiDecodeException>()),
      );
    });
  });

  group('attribution consistency', () {
    test('a continuation that disagrees with its opener is rejected', () {
      return expectFails(
        [runStarted(), textStart('m1', sub: 's1'), textEnd('m1', sub: 's2')],
        [
          "Cannot send 'TEXT_MESSAGE_END': subagentRunId 's2' does not match "
              "the message 'm1' opener's subagent 's1'.",
        ],
      );
    });

    test('a tagged continuation of a parent-owned opener is rejected', () {
      return expectFails(
        [runStarted(), textStart('m1'), textContent('m1', sub: 's1')],
        ["does not match the message 'm1' opener's subagent '(the parent "],
      );
    });

    test('an empty-string tag on a parent-owned message is rejected', () {
      return expectFails(
        [runStarted(), textStart('m1'), textContent('m1', sub: '')],
        ["subagentRunId '' does not match"],
      );
    });

    test('an s1 tag on a message owned by the empty-string id is rejected', () {
      return expectFails(
        [runStarted(), textStart('m1', sub: ''), textContent('m1', sub: 's1')],
        ["opener's subagent ''."],
      );
    });

    test('TOOL_CALL_ARGS disagreeing with its opener is rejected', () {
      return expectFails(
        [runStarted(), toolStart('tc1', sub: 's1'), toolArgs('tc1', sub: 's2')],
        ["Cannot send 'TOOL_CALL_ARGS'", "the tool call 'tc1'", 'does not '],
      );
    });

    test('TOOL_CALL_END disagreeing with its opener is rejected', () {
      return expectFails(
        [runStarted(), toolStart('tc1', sub: 's1'), toolEnd('tc1', sub: 's2')],
        ["Cannot send 'TOOL_CALL_END'", 'does not match'],
      );
    });

    test('an untagged continuation of a tagged tool call passes', () {
      return expectPasses([
        runStarted(),
        toolStart('tc1', sub: 's1'),
        toolArgs('tc1'),
        toolEnd('tc1'),
        runFinished(),
      ]);
    });

    test('REASONING_END disagreeing with its opener is rejected', () {
      return expectFails(
        [
          runStarted(),
          reasoningStart('r1', sub: 's1'),
          reasoningEnd('r1', sub: 's2'),
        ],
        ["Cannot send 'REASONING_END'", "the reasoning message 'r1'"],
      );
    });

    test(
      'a second reasoning opener that contradicts the first is rejected',
      () {
        return expectFails(
          [
            runStarted(),
            reasoningStart('r1', sub: 's1'),
            reasoningMessageStart('r1', sub: 's2'),
          ],
          ["Cannot send 'REASONING_MESSAGE_START'", 'does not match'],
        );
      },
    );

    test('a tagged reasoning opener on a parent-owned first is rejected', () {
      return expectFails(
        [
          runStarted(),
          reasoningStart('r1'),
          reasoningMessageStart('r1', sub: 's1'),
        ],
        ["opener's subagent '(the parent agent)'"],
      );
    });

    test('an untagged reopen after REASONING_END keeps the owner', () {
      return expectFails(
        [
          runStarted(),
          reasoningStart('r1', sub: 's1'),
          reasoningEnd('r1'),
          reasoningStart('r1'),
          reasoningEnd('r1', sub: 's2'),
        ],
        ["opener's subagent 's1'"],
      );
    });

    test('a tool-call encrypted value checks the tool call owner', () {
      return expectFails(
        [
          runStarted(),
          toolStart('tc1', sub: 's1'),
          encrypted('tool-call', 'tc1', sub: 's2'),
        ],
        [
          "Cannot send 'REASONING_ENCRYPTED_VALUE'",
          "the tool call 'tc1' opener's subagent 's1'",
        ],
      );
    });

    test('the tool call owner survives TOOL_CALL_END', () {
      return expectFails(
        [
          runStarted(),
          toolStart('tc1', sub: 's1'),
          toolEnd('tc1'),
          encrypted('tool-call', 'tc1', sub: 's2'),
        ],
        ["the tool call 'tc1'"],
      );
    });

    test('a message encrypted value whose id is only a tool call passes', () {
      // Owners are per kind: "x" as a tool call says nothing about message x.
      return expectPasses([
        runStarted(),
        toolStart('x', sub: 's1'),
        toolEnd('x'),
        encrypted('message', 'x', sub: 's2'),
        runFinished(),
      ]);
    });

    test('a message encrypted value checks a REASONING owner', () {
      return expectFails(
        [
          runStarted(),
          reasoningMessageStart('r1', sub: 's1'),
          reasoningMessageEnd('r1'),
          encrypted('message', 'r1', sub: 's2'),
        ],
        ["the message 'r1' opener's subagent 's1'"],
      );
    });

    test('an agreeing message encrypted value on reasoning passes', () {
      return expectPasses([
        runStarted(),
        reasoningMessageStart('r1', sub: 's1'),
        reasoningMessageEnd('r1'),
        encrypted('message', 'r1', sub: 's1'),
        runFinished(),
      ]);
    });

    test('a message encrypted value checks a TEXT owner', () {
      return expectFails(
        [
          runStarted(),
          textStart('m1', sub: 's1'),
          textEnd('m1'),
          encrypted('message', 'm1', sub: 's2'),
        ],
        ["the message 'm1' opener's subagent 's1'"],
      );
    });

    test('ACTIVITY_DELTA disagreeing with its snapshot is rejected', () {
      return expectFails(
        [
          runStarted(),
          activitySnapshot('a1', sub: 's1'),
          activityDelta('a1', sub: 's2'),
        ],
        ["Cannot send 'ACTIVITY_DELTA'", "the activity 'a1'"],
      );
    });

    test('a replace:false snapshot does not take over an activity', () {
      return expectFails(
        [
          runStarted(),
          activitySnapshot('a1', sub: 's1'),
          activitySnapshot('a1', sub: 's2', replace: false),
          activityDelta('a1', sub: 's2'),
        ],
        ["the activity 'a1' opener's subagent 's1'"],
      );
    });

    test('an omitted replace re-owns the activity', () {
      return expectPasses([
        runStarted(),
        activitySnapshot('a1', sub: 's1'),
        activitySnapshot('a1', sub: 's2'),
        activityDelta('a1', sub: 's2'),
        runFinished(),
      ]);
    });

    test('state events attributed to a subagent are accepted', () {
      return expectPasses([
        runStarted(),
        subStarted('s1'),
        {'type': 'STATE_DELTA', 'delta': <Object?>[], 'subagentRunId': 's1'},
        subFinished('s1'),
        runFinished(),
      ]);
    });
  });

  group('reopening a closed id', () {
    test('TEXT_MESSAGE_START under a different subagent is rejected', () {
      return expectFails(
        [
          runStarted(),
          textStart('m1', sub: 's1'),
          textEnd('m1'),
          textStart('m1', sub: 's2'),
        ],
        ["Cannot send 'TEXT_MESSAGE_START'", 'does not match'],
      );
    });

    test('TOOL_CALL_START under a different subagent is rejected', () {
      return expectFails(
        [
          runStarted(),
          toolStart('tc1', sub: 's1'),
          toolEnd('tc1'),
          toolStart('tc1', sub: 's2'),
        ],
        ["Cannot send 'TOOL_CALL_START'", "the tool call 'tc1'"],
      );
    });

    test('reopening under the same subagent passes', () {
      return expectPasses([
        runStarted(),
        textStart('m1', sub: 's1'),
        textEnd('m1'),
        textStart('m1', sub: 's1'),
        textEnd('m1'),
        runFinished(),
      ]);
    });

    test('an untagged reopen keeps the first owner', () {
      return expectFails(
        [
          runStarted(),
          textStart('m1', sub: 's1'),
          textEnd('m1'),
          textStart('m1'),
          textContent('m1', sub: 's2'),
        ],
        ["opener's subagent 's1'"],
      );
    });
  });

  group('tool call vs parent message', () {
    test('an explicit tag conflicting with the parent is rejected', () {
      return expectFails(
        [
          runStarted(),
          textStart('m1', sub: 's1'),
          toolStart('tc1', parent: 'm1', sub: 's2'),
        ],
        [
          "Cannot send 'TOOL_CALL_START': subagentRunId 's2' does not match "
              "its parent message 'm1' owner 's1'. A tool call belongs to the "
              'message that carries it.',
        ],
      );
    });

    test('a tagged tool call on a parent-owned message is rejected', () {
      return expectFails(
        [
          runStarted(),
          textStart('m1'),
          toolStart('tc1', parent: 'm1', sub: 's1'),
        ],
        ["its parent message 'm1' owner '(the parent agent)'"],
      );
    });

    test('an untagged tool call inherits its parent message owner', () {
      return expectFails(
        [
          runStarted(),
          textStart('m1', sub: 's1'),
          toolStart('tc1', parent: 'm1'),
          toolArgs('tc1', sub: 's2'),
        ],
        ["the tool call 'tc1' opener's subagent 's1'"],
      );
    });

    test('a matching tag and an inheriting untagged call pass', () {
      return expectPasses([
        runStarted(),
        textStart('m1', sub: 's1'),
        toolStart('tc1', parent: 'm1', sub: 's1'),
        toolStart('tc2', parent: 'm1'),
        toolArgs('tc2', sub: 's1'),
        toolEnd('tc1'),
        toolEnd('tc2'),
        textEnd('m1'),
        runFinished(),
      ]);
    });

    test('an untagged reopen under a differently-owned parent is rejected', () {
      return expectFails(
        [
          runStarted(),
          textStart('m1', sub: 's1'),
          textStart('m2', sub: 's2'),
          toolStart('tc1', parent: 'm1'),
          toolEnd('tc1'),
          toolStart('tc1', parent: 'm2'),
        ],
        [
          "Cannot send 'TOOL_CALL_START': tool call 'tc1' is owned by 's1' "
              "but its parent message 'm2' is owned by 's2'.",
        ],
      );
    });
  });

  group('ownership seeded from history', () {
    test('reopening a snapshot message under another subagent fails', () {
      return expectFails(
        [
          runStarted(),
          messagesSnapshot([assistant('m1', sub: 's1')]),
          textStart('m1', sub: 's2'),
        ],
        ["the message 'm1' opener's subagent 's1'"],
      );
    });

    test('a tagged reopen of a parent-owned snapshot message fails', () {
      return expectFails(
        [
          runStarted(),
          messagesSnapshot([assistant('m1')]),
          textStart('m1', sub: 's1'),
        ],
        ["opener's subagent '(the parent agent)'"],
      );
    });

    test('reopening under its own subagent, or untagged, passes', () {
      return expectPasses([
        runStarted(),
        messagesSnapshot([assistant('m1', sub: 's1')]),
        textStart('m1', sub: 's1'),
        textEnd('m1'),
        textStart('m1'),
        textEnd('m1', sub: 's1'),
        runFinished(),
      ]);
    });

    test('the RUN_STARTED input echo seeds ownership', () {
      return expectFails(
        [
          runStarted('r1', runInput([assistant('m1', sub: 's1')])),
          textStart('m1', sub: 's2'),
        ],
        ["the message 'm1' opener's subagent 's1'"],
      );
    });

    test('a snapshot reasoning message seeds the reasoning bucket', () {
      return expectFails(
        [
          runStarted(),
          messagesSnapshot([
            {
              'id': 'r1',
              'role': 'reasoning',
              'content': 'x',
              'subagentRunId': 's1',
            },
          ]),
          reasoningMessageStart('r1', sub: 's2'),
        ],
        ["the reasoning message 'r1' opener's subagent 's1'"],
      );
    });

    test('a later snapshot authoritatively replaces the owner', () {
      return expectPasses([
        runStarted(),
        textStart('m1', sub: 's1'),
        textEnd('m1'),
        messagesSnapshot([assistant('m1', sub: 's2')]),
        textStart('m1', sub: 's2'),
        textEnd('m1'),
        runFinished(),
      ]);
    });

    test('the input echo does not replace an existing owner', () {
      // Within one run the echo arrives first, so it only ever seeds; the
      // snapshot that follows is authoritative.
      return expectFails(
        [
          runStarted('r1', runInput([assistant('m1', sub: 's1')])),
          messagesSnapshot([assistant('m1', sub: 's2')]),
          textStart('m1', sub: 's1'),
        ],
        ["opener's subagent 's2'"],
      );
    });

    test('a snapshot tool call is seeded under its message owner', () {
      return expectFails(
        [
          runStarted(),
          messagesSnapshot([
            assistant('m1', sub: 's1', toolCalls: ['tc1']),
          ]),
          toolStart('tc1', sub: 's2'),
        ],
        ["the tool call 'tc1' opener's subagent 's1'"],
      );
    });

    test('a snapshot activity is seeded and survives replace:false', () {
      return expectFails(
        [
          runStarted(),
          messagesSnapshot([
            {
              'id': 'a1',
              'role': 'activity',
              'activityType': 'plan',
              'content': <String, Object?>{},
              'subagentRunId': 's1',
            },
          ]),
          activitySnapshot('a1', sub: 's2', replace: false),
          activityDelta('a1', sub: 's2'),
        ],
        ["the activity 'a1' opener's subagent 's1'"],
      );
    });
  });

  group('tool result mints an owned message', () {
    test('reopening a result message under another subagent fails', () {
      return expectFails(
        [
          runStarted(),
          toolResult('m9', 'tc1', sub: 's1'),
          textStart('m9', sub: 's2'),
        ],
        ["the message 'm9' opener's subagent 's1'"],
      );
    });

    test('a tagged reopen of an untagged result message fails', () {
      return expectFails(
        [runStarted(), toolResult('m9', 'tc1'), textStart('m9', sub: 's1')],
        ["opener's subagent '(the parent agent)'"],
      );
    });

    test('an untagged or same-owner reopen passes', () {
      return expectPasses([
        runStarted(),
        toolResult('m9', 'tc1', sub: 's1'),
        textStart('m9'),
        textEnd('m9', sub: 's1'),
        runFinished(),
      ]);
    });
  });
}
