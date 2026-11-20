import 'dart:convert';
import 'dart:io';

import 'package:ag_ui_example/models/chat_message.dart';
import 'package:ag_ui_example/models/endpoint_config.dart';
import 'package:ag_ui_example/pages/client_tools_page.dart';
import 'package:ag_ui_example/services/ag_ui_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'Codex chat preserves thread, full history, and assistant IDs over HTTP',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final requests = <Map<String, dynamic>>[];
      server.listen((request) async {
        expect(request.uri.path, '/agentic_chat');
        final payload = jsonDecode(
          await utf8.decoder.bind(request).join(),
        ) as Map<String, dynamic>;
        requests.add(payload);
        final turn = requests.length;
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
        );
        void emit(Map<String, dynamic> event) =>
            request.response.write('data: ${jsonEncode(event)}\n\n');
        emit({
          'type': 'RUN_STARTED',
          'threadId': payload['threadId'],
          'runId': payload['runId'],
        });
        final replies = turn == 1
            ? {
                'codex_first': ['Hello ', 'Alex'],
                'codex_second': ['How can I help?'],
              }
            : {
                'codex_recall': ['Your name is Alex.'],
              };
        for (final reply in replies.entries) {
          emit({
            'type': 'TEXT_MESSAGE_START',
            'messageId': reply.key,
            'role': 'assistant',
          });
          for (final delta in reply.value) {
            emit({
              'type': 'TEXT_MESSAGE_CONTENT',
              'messageId': reply.key,
              'delta': delta,
            });
          }
          emit({'type': 'TEXT_MESSAGE_END', 'messageId': reply.key});
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
        endpoint: EndpointConfig.endpointsFor('codex').single,
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

      state.sendMessage('Hi, my name is Alex');
      await waitForIdle().timeout(const Duration(seconds: 5));
      state.sendMessage('What is my name?');
      await waitForIdle().timeout(const Duration(seconds: 5));
      expect(
        requests,
        hasLength(2),
        reason: 'Text chat must not trigger a tool continuation.',
      );
      expect(requests.last['threadId'], requests.first['threadId']);
      expect(requests.last['runId'], isNot(requests.first['runId']));
      for (final request in requests) {
        expect(request['tools'], isEmpty);
        expect(request['forwardedProps'], isEmpty);
      }
      final history = (requests.last['messages'] as List)
          .cast<Map<String, dynamic>>();
      expect(history.map((message) => message['role']), [
        'user',
        'assistant',
        'assistant',
        'user',
      ]);
      expect(history[1]['id'], 'codex_first');
      expect(history[1]['content'], 'Hello Alex');
      expect(history[2]['id'], 'codex_second');
      expect(history[2]['content'], 'How can I help?');
      final assistants = state.messages.where(
        (message) => message.type == ChatMessageType.assistant,
      );
      expect(assistants.map((message) => message.id), [
        'codex_first',
        'codex_second',
        'codex_recall',
      ]);
      expect(assistants.map((message) => message.content), [
        'Hello Alex',
        'How can I help?',
        'Your name is Alex.',
      ]);
      expect(assistants.every((message) => !message.isStreaming), isTrue);
    },
  );

  test('Codex run error releases loading state without retrying', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    var calls = 0;
    server.listen((request) async {
      calls++;
      final payload = jsonDecode(
        await utf8.decoder.bind(request).join(),
      ) as Map<String, dynamic>;
      request.response.headers.contentType = ContentType(
        'text',
        'event-stream',
      );
      for (final event in [
        {
          'type': 'RUN_STARTED',
          'threadId': payload['threadId'],
          'runId': payload['runId'],
        },
        {
          'type': 'RUN_ERROR',
          'message': 'Codex could not complete this run.',
          'code': 'CODEX_ERROR',
        },
      ]) {
        request.response.write('data: ${jsonEncode(event)}\n\n');
      }
      await request.response.close();
    });
    final service = AgUiService(baseUrl: 'http://127.0.0.1:${server.port}');
    final state = ClientToolsPageState(
      endpoint: EndpointConfig.endpointsFor('codex').single,
      service: service,
    );
    addTearDown(() async {
      state.dispose();
      await service.close();
      await server.close(force: true);
    });
    state.sendMessage('Hello');
    await Future<void>(() async {
      while (state.busy) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
    }).timeout(const Duration(seconds: 5));
    expect(calls, 1);
    expect(state.busy, isFalse);
    expect(
      state.messages.any(
        (message) =>
            message.content.contains('Codex could not complete this run.'),
      ),
      isTrue,
    );
  });
}
