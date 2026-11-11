import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ag_ui/ag_ui.dart';
import 'package:ag_ui_example/models/endpoint_config.dart';
import 'package:ag_ui_example/pages/chat_page.dart';
import 'package:ag_ui_example/pages/client_tools_page.dart';
import 'package:ag_ui_example/services/ag_ui_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

class _ControlledClient extends http.BaseClient {
  final response = Completer<http.StreamedResponse>();
  final sent = Completer<void>();
  late final StreamController<List<int>> bytes;
  int closeCount = 0;
  int cancelCount = 0;

  _ControlledClient({bool failCancellation = false}) {
    bytes = StreamController<List<int>>(
      onCancel: () {
        cancelCount++;
        if (failCancellation) {
          return Future<void>.error(StateError('Cancel failed'));
        }
      },
    );
  }

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    sent.complete();
    return response.future;
  }

  void respond({int statusCode = 200}) {
    response.complete(
      http.StreamedResponse(
        bytes.stream,
        statusCode,
        headers: {'content-type': 'text/event-stream'},
      ),
    );
  }

  void emit(Map<String, Object> event) {
    bytes.add(utf8.encode('data: ${jsonEncode(event)}\n\n'));
  }

  @override
  void close() => closeCount++;
}

class _MultiplexClient extends http.BaseClient {
  final List<_ControlledClient> requests;
  int _next = 0;
  int closeCount = 0;

  _MultiplexClient(this.requests);

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      requests[_next++].send(request);

  @override
  void close() => closeCount++;
}

const _started = {'type': 'RUN_STARTED', 'threadId': 't', 'runId': 'r'};
final _chatEndpoint = EndpointConfig.availableEndpoints.first;

void main() {
  test(
    'service disposal cancels an idle response and closes HTTP once',
    () async {
      final client = _ControlledClient();
      final service = AgUiService(httpClient: client);
      final events = <BaseEvent>[];
      final statuses = <ConnectionStatus>[];
      final statusDone = Completer<void>();
      service.connectionStatus.listen(
        statuses.add,
        onDone: statusDone.complete,
      );
      final done = Completer<void>();
      service
          .sendMessage('agentic_chat', 'hello')
          .listen(
            events.add,
            onError: (Object error) => fail('Unexpected error: $error'),
            onDone: done.complete,
          );
      await client.sent.future;
      client.respond();
      client.emit(_started);
      await pumpEventQueue();
      expect(events, hasLength(1));

      service.dispose();
      await service.close().timeout(const Duration(seconds: 2));
      await done.future.timeout(const Duration(seconds: 2));
      await statusDone.future.timeout(const Duration(seconds: 2));
      final statusCount = statuses.length;
      client.emit({'type': 'TEXT_MESSAGE_START', 'messageId': 'late'});
      await pumpEventQueue();
      expect(events, hasLength(1));
      expect(statuses, hasLength(statusCount));
      expect(client.cancelCount, 1);
      expect(client.closeCount, 1);
      service.dispose();
      await service.close();
      expect(client.closeCount, 1);
      await client.bytes.close();
    },
  );

  test('disposal cancels pending send and rejects a late response', () async {
    final client = _ControlledClient();
    final service = AgUiService(httpClient: client);
    final events = <BaseEvent>[];
    final errors = <Object>[];
    final done = Completer<void>();
    service
        .sendMessage('agentic_chat', 'hello')
        .listen(events.add, onError: errors.add, onDone: done.complete);
    await client.sent.future;
    service.dispose();
    await service.close().timeout(const Duration(seconds: 2));
    await done.future.timeout(const Duration(seconds: 2));
    client.respond();
    client.emit(_started);
    await pumpEventQueue();
    expect(events, isEmpty);
    expect(errors, isEmpty);
    expect(client.cancelCount, 1);
    expect(client.closeCount, 1);
    await client.bytes.close();
  });

  test(
    'disposal releases an idle HTTP error response without surfacing errors',
    () async {
      final client = _ControlledClient();
      final service = AgUiService(httpClient: client);
      final errors = <Object>[];
      final done = Completer<void>();
      service
          .sendMessage('agentic_chat', 'hello')
          .listen((_) {}, onError: errors.add, onDone: done.complete);
      await client.sent.future;
      client.respond(statusCode: 500);
      client.bytes.add(utf8.encode('Service unavailable'));
      await pumpEventQueue();
      await service.close().timeout(const Duration(seconds: 2));
      await done.future.timeout(const Duration(seconds: 2));
      expect(errors, isEmpty);
      expect(client.cancelCount, 1);
      expect(client.closeCount, 1);
      await client.bytes.close();
    },
  );

  test('late send failure after disposal does not leak an error', () async {
    final client = _ControlledClient();
    final service = AgUiService(httpClient: client);
    final errors = <Object>[];
    service
        .sendMessage('agentic_chat', 'hello')
        .listen((_) {}, onError: errors.add);
    await client.sent.future;
    await service.close().timeout(const Duration(seconds: 2));
    client.response.completeError(
      http.ClientException('Late connection failure'),
    );
    await pumpEventQueue();
    expect(errors, isEmpty);
    expect(client.closeCount, 1);
  });

  test('an unlistened stream cannot start a request after close', () async {
    final client = _ControlledClient();
    final service = AgUiService(httpClient: client);
    final stream = service.sendMessage('agentic_chat', 'hello');
    await service.close();
    await expectLater(stream, emitsError(isA<StateError>()));
    expect(client.sent.isCompleted, isFalse);
    expect(client.closeCount, 1);
  });

  test(
    'client-tools page disposal stops active work and closes its client',
    () async {
      final client = _ControlledClient();
      final service = AgUiService(httpClient: client);
      final page = ClientToolsPageState(
        endpoint: _chatEndpoint,
        service: service,
      );
      var notifications = 0;
      page.addListener(() => notifications++);
      page.sendMessage('hello');
      await client.sent.future;
      client.respond();
      client.emit(_started);
      await pumpEventQueue();
      page.dispose();
      final countAtDispose = notifications;
      await service.close().timeout(const Duration(seconds: 2));
      client.emit({'type': 'TEXT_MESSAGE_START', 'messageId': 'late'});
      await pumpEventQueue();
      expect(notifications, countAtDispose);
      expect(client.cancelCount, 1);
      expect(client.closeCount, 1);
      await client.bytes.close();
    },
  );

  test('chat page disposal cancels queued connection notifications', () async {
    final client = _ControlledClient();
    final service = AgUiService(httpClient: client);
    final page = ChatPageState(endpoint: _chatEndpoint, service: service);
    page.sendMessage('hello');
    // Connecting/connected notifications have been queued but not delivered.
    page.dispose();
    await service.close().timeout(const Duration(seconds: 2));
    await pumpEventQueue();
    expect(client.closeCount, 1);
    expect(client.sent.isCompleted, isFalse);
  });

  test(
    'paused event and status listeners do not block transport cleanup',
    () async {
      final client = _ControlledClient();
      final service = AgUiService(httpClient: client);
      final status = service.connectionStatus.listen((_) {});
      final events = <BaseEvent>[];
      final subscription = service
          .sendMessage('agentic_chat', 'hello')
          .listen(events.add);
      await client.sent.future;
      client.respond();
      client.emit(_started);
      await pumpEventQueue();
      expect(events, hasLength(1));
      subscription.pause();
      status.pause();

      await service.close().timeout(const Duration(seconds: 2));
      expect(client.cancelCount, 1);
      expect(client.closeCount, 1);
      client.emit(_started);
      subscription.resume();
      status.resume();
      await pumpEventQueue();
      expect(events, hasLength(1));
      await subscription.cancel();
      await status.cancel();
      await client.bytes.close();
    },
  );

  test(
    'consumer cancellation releases only its own concurrent response',
    () async {
      final first = _ControlledClient();
      final second = _ControlledClient();
      final client = _MultiplexClient([first, second]);
      final service = AgUiService(httpClient: client);
      final one = service.sendMessage('agentic_chat', 'one').listen((_) {});
      final events = <BaseEvent>[];
      service.sendMessage('agentic_chat', 'two').listen(events.add);
      await Future.wait([first.sent.future, second.sent.future]);
      first.respond();
      second.respond();
      first.emit(_started);
      second.emit(_started);
      await pumpEventQueue();

      await one.cancel().timeout(const Duration(seconds: 2));
      expect(first.cancelCount, 1);
      expect(second.cancelCount, 0);
      expect(client.closeCount, 0);
      second.emit({'type': 'TEXT_MESSAGE_START', 'messageId': 'second'});
      await pumpEventQueue();
      expect(events, hasLength(2));
      await service.close().timeout(const Duration(seconds: 2));
      expect(second.cancelCount, 1);
      expect(client.closeCount, 1);
      await first.bytes.close();
      await second.bytes.close();
    },
  );

  test('transport errors are delivered and cleanup still completes', () async {
    final client = _ControlledClient();
    final service = AgUiService(httpClient: client);
    final errors = <Object>[];
    final done = Completer<void>();
    service
        .sendMessage('agentic_chat', 'hello')
        .listen((_) {}, onError: errors.add, onDone: done.complete);
    await client.sent.future;
    client.respond();
    client.emit(_started);
    await pumpEventQueue();
    client.bytes.addError(http.ClientException('Connection lost'));
    await done.future.timeout(const Duration(seconds: 2));
    expect(errors, hasLength(1));
    await service.close().timeout(const Duration(seconds: 2));
    expect(client.cancelCount, 1);
    expect(client.closeCount, 1);
    await client.bytes.close();
  });

  test(
    'explicit close reports cancellation failure without unhandled errors',
    () async {
      final client = _ControlledClient(failCancellation: true);
      final service = AgUiService(httpClient: client);
      final done = Completer<void>();
      service
          .sendMessage('agentic_chat', 'hello')
          .listen((_) {}, onDone: done.complete);
      await client.sent.future;
      client.respond();
      client.emit(_started);
      await pumpEventQueue();
      await expectLater(service.close(), throwsStateError);
      await done.future.timeout(const Duration(seconds: 2));
      await pumpEventQueue();
      expect(client.cancelCount, 1);
      expect(client.closeCount, 1);
      await client.bytes.close();
    },
  );

  test('close interrupts an actual idle HTTP SSE connection', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(server.close);
    final disconnected = Completer<void>();
    server.listen((socket) {
      addTearDown(socket.destroy);
      var responded = false;
      final request = StringBuffer();
      socket.listen((bytes) {
        request.write(utf8.decode(bytes));
        if (responded || !request.toString().contains('\r\n\r\n')) return;
        responded = true;
        socket.write(
          'HTTP/1.1 200 OK\r\n'
          'Content-Type: text/event-stream\r\n'
          'Connection: close\r\n\r\n'
          'data: ${jsonEncode(_started)}\n\n',
        );
        // Stay idle until the client actually disconnects.
      }, onDone: disconnected.complete);
    });
    final service = AgUiService(baseUrl: 'http://127.0.0.1:${server.port}');
    addTearDown(service.close);
    final received = Completer<void>();
    final done = Completer<void>();
    service.sendMessage('agentic_chat', 'hello').listen((_) {
      if (!received.isCompleted) received.complete();
    }, onDone: done.complete);
    await received.future.timeout(const Duration(seconds: 2));
    await service.close().timeout(const Duration(seconds: 2));
    await done.future.timeout(const Duration(seconds: 2));
    await disconnected.future.timeout(const Duration(seconds: 2));
  });
}
