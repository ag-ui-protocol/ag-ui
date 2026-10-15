import 'package:agui/agui.dart';
import 'package:agui/src/pipeline/era/era_0_0_39.dart';
import 'package:agui/src/pipeline/era/era_0_0_57.dart';
import 'package:agui/src/pipeline/era/select.dart';
import 'package:test/test.dart';

import '../support/scripted_agent.dart';

void main() {
  test('selection by ceiling', () {
    expect(selectEraShims(null).inbound, isEmpty);
    expect(selectEraShims('1.0').outgoing, isEmpty);
    expect(selectEraShims('0.0.57').inbound.length, 1);
    expect(selectEraShims('0.0.57').outgoing.length, 1);
    expect(selectEraShims('0.0.45').inbound.length, 2);
    expect(selectEraShims('0.0.39').outgoing.length, 2);
  });

  test(
    '0.0.39 flattens content, warns about dropped parts, drops parentRunId',
    () {
      final warnings = <String>[];
      final out = flattenContentFor0039(
        RunAgentInput(
          threadId: 't',
          runId: 'r',
          parentRunId: 'p',
          messages: const [
            UserMessage(
              id: 'u',
              content: [
                TextPart(text: 'What?'),
                ImagePart(
                  source: UrlSource(
                    value: 'https://x/c.png',
                    mimeType: 'image/png',
                  ),
                ),
              ],
            ),
          ],
        ),
        warnings.add,
      );
      expect((out.messages.single as UserMessage).content, 'What?');
      expect(out.parentRunId, isNull);
      expect(warnings.single, contains('DROPS non-text parts (image)'));
    },
  );

  test('0.0.39 leaves a malformed text part alone and warns', () {
    final warnings = <String>[];
    final message = {
      'id': 'u',
      'role': 'user',
      'content': [
        {'type': 'text', 'text': 42},
      ],
    };
    expect(
      identical(sanitizeMessageContent(message, warnings.add), message),
      isTrue,
    );
    expect(warnings.single, contains('Not flattening message content'));
  });

  test('0.0.57 strips attribution from the request', () {
    final out = stripSubagentsFor0057(
      RunAgentInput(
        threadId: 't',
        runId: 'r',
        messages: const [
          UserMessage(id: 'u', content: 'hi', subagentRunId: 's'),
        ],
      ),
      ignoreWarnings,
    );
    expect(out.messages.single.subagentRunId, isNull);
  });

  test(
    '0.0.57 drops subagent events with a warning and strips attribution',
    () async {
      final warnings = <String>[];
      final out =
          await dropSubagentsFor0057(
            Stream.fromIterable([
              {'type': 'RUN_STARTED', 'threadId': 't', 'runId': 'r'},
              {'type': 'SUBAGENT_STARTED', 'subagentRunId': 's', 'name': 'n'},
              {
                'type': 'TEXT_MESSAGE_START',
                'messageId': 'm',
                'subagentRunId': 's',
              },
              {
                'type': 'MESSAGES_SNAPSHOT',
                'messages': [
                  {
                    'id': 'u',
                    'role': 'user',
                    'content': 'x',
                    'subagentRunId': 's',
                  },
                ],
              },
              {
                'type': 'RUN_FINISHED',
                'threadId': 't',
                'runId': 'r',
                'outcome': {
                  'type': 'interrupt',
                  'interrupts': [
                    {'id': 'i', 'reason': 'x', 'subagentRunId': 's'},
                  ],
                },
              },
            ]),
            warnings.add,
          ).toList();
      expect(out.map((e) => e['type']), [
        'RUN_STARTED',
        'TEXT_MESSAGE_START',
        'MESSAGES_SNAPSHOT',
        'RUN_FINISHED',
      ]);
      expect(out[1].containsKey('subagentRunId'), isFalse);
      expect(
        ((out[2]['messages'] as List).first as Map).containsKey(
          'subagentRunId',
        ),
        isFalse,
      );
      final interrupt =
          ((out[3]['outcome'] as Map)['interrupts'] as List).first as Map;
      expect(interrupt.containsKey('subagentRunId'), isFalse);
      expect(warnings.single, contains('dropping SUBAGENT_STARTED'));
    },
  );

  test(
    'a pinned 0.0.39 peer gets a flattened request through the pipeline',
    () async {
      final warnings = <String>[];
      final agent = scripted(
        const [
          {'type': 'RUN_STARTED', 'threadId': 't', 'runId': 'r'},
          {'type': 'RUN_FINISHED', 'threadId': 't', 'runId': 'r'},
        ],
        initialMessages: const [
          UserMessage(
            id: 'u',
            content: [TextPart(text: 'a'), TextPart(text: 'b')],
            subagentRunId: 's',
          ),
        ],
        maxProtocolVersion: '0.0.39',
        onWarning: warnings.add,
      );
      await agent.runAgent(runId: 'r');
      final sent = agent.inputs.single;
      expect((sent.messages.single as UserMessage).content, 'ab');
      expect(sent.messages.single.subagentRunId, isNull);
      expect(sent.protocolVersion, isNull);
      expect(warnings, isEmpty);
    },
  );
}
