import 'dart:convert';
import 'dart:io';

import 'package:ag_ui_example/models/chat_message.dart';
import 'package:ag_ui_example/models/endpoint_config.dart';
import 'package:ag_ui_example/pages/client_tools_page.dart';
import 'package:ag_ui_example/services/ag_ui_service.dart';
import 'package:flutter_test/flutter_test.dart';

// Mirrors the provider constraint which rejected the reviewer's follow-up:
// every assistant tool proposal must be immediately followed by its results.
bool _hasValidToolHistory(List<Map<String, dynamic>> messages) {
  final pending = <String>{};
  for (final message in messages) {
    if (message['role'] == 'tool') {
      if (!pending.remove(message['toolCallId'])) return false;
      continue;
    }
    if (pending.isNotEmpty) return false;
    for (final call in (message['toolCalls'] as List? ?? const [])) {
      pending.add(call['id'] as String);
    }
  }
  return pending.isEmpty;
}

void main() {
  test(
    'HTTP follow-up after Go-style re-ID snapshots keeps tool history valid',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final requests = <List<Map<String, dynamic>>>[];
      final rejected = <int>[];
      server.listen((request) async {
        final payload =
            jsonDecode(await utf8.decoder.bind(request).join())
                as Map<String, dynamic>;
        final history = (payload['messages'] as List)
            .cast<Map<String, dynamic>>();
        requests.add(history);
        final turn = requests.length;
        if (!_hasValidToolHistory(history)) {
          rejected.add(turn);
          request.response.statusCode = HttpStatus.badRequest;
          request.response.write('Unanswered or orphaned tool call');
          await request.response.close();
          return;
        }

        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
        );
        void emit(Map<String, dynamic> event) =>
            request.response.write('data: ${jsonEncode(event)}\n\n');
        final conversation = <Map<String, dynamic>>[
          if (turn == 1)
            {'id': 'system', 'role': 'system', 'content': 'You are helpful.'},
          ...history,
          if (turn == 1)
            {
              'id': 'proposal',
              'role': 'assistant',
              'toolCalls': [
                {
                  'id': 'calculate_1',
                  'type': 'function',
                  'function': {
                    'name': 'calculate',
                    'arguments': '{"expression":"6*7"}',
                  },
                },
              ],
            }
          else
            {'id': 'answer', 'role': 'assistant', 'content': '42'},
        ];
        emit({
          'type': 'RUN_STARTED',
          'threadId': payload['threadId'],
          'runId': payload['runId'],
        });
        if (turn > 1) {
          emit({'type': 'TEXT_MESSAGE_START', 'messageId': 'stream_$turn'});
          emit({
            'type': 'TEXT_MESSAGE_CONTENT',
            'messageId': 'stream_$turn',
            'delta': '42',
          });
          emit({'type': 'TEXT_MESSAGE_END', 'messageId': 'stream_$turn'});
        }
        // Go's toAGUIMessages generates fresh IDs for every snapshot entry,
        // including messages which were already sent in the input history.
        for (var snapshot = 0; snapshot < 2; snapshot++) {
          emit({
            'type': 'MESSAGES_SNAPSHOT',
            'messages': [
              for (var i = 0; i < conversation.length; i++)
                {...conversation[i], 'id': 'snapshot_${turn}_${snapshot}_$i'},
            ],
          });
        }
        emit({
          'type': 'RUN_FINISHED',
          'threadId': payload['threadId'],
          'runId': payload['runId'],
        });
        await request.response.close();
      });

      final service = AgUiService(baseUrl: 'http://127.0.0.1:${server.port}');
      final state = ClientToolsPageState(
        endpoint: EndpointConfig.availableEndpoints.firstWhere(
          (e) => e.path == 'agentic_chat',
        ),
        service: service,
      );
      addTearDown(() async {
        state.dispose();
        await service.close();
        await server.close(force: true);
      });
      Future<void> waitForIdle() async {
        while (state.busy) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
      }

      state.sendMessage('Calculate 6 * 7');
      await waitForIdle().timeout(const Duration(seconds: 5));
      state.sendMessage('What was that result?');
      await waitForIdle().timeout(const Duration(seconds: 5));

      expect(requests, hasLength(3));
      expect(
        rejected,
        isEmpty,
        reason: 'the follow-up must not produce HTTP 400',
      );
      final followUp = requests.last;
      expect(followUp.map((m) => m['role']), [
        'system',
        'user',
        'assistant',
        'tool',
        'assistant',
        'user',
      ]);
      expect(followUp.take(5).map((m) => m['id']), [
        for (var i = 0; i < 5; i++) 'snapshot_2_1_$i',
      ]);
      expect(followUp[2]['toolCalls'], hasLength(1));
      expect(followUp[3]['toolCallId'], 'calculate_1');
      expect(followUp[4]['content'], '42');
      expect(followUp.last['content'], 'What was that result?');
      expect(
        state.messages.where((m) => m.type == ChatMessageType.tool),
        hasLength(1),
      );
      expect(
        state.messages.where((m) => m.type == ChatMessageType.system),
        isEmpty,
      );
    },
  );
}
