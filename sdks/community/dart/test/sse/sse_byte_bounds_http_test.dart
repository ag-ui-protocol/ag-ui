import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ag_ui/ag_ui.dart';
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

class _ControlledClient extends http.BaseClient {
  // ignore: close_sinks
  final source = StreamController<List<int>>();
  bool closed = false;
  int requests = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests++;
    return http.StreamedResponse(source.stream, 200);
  }

  @override
  void close() {
    closed = true;
  }
}

class _CountingBackoff implements BackoffStrategy {
  int calls = 0;

  @override
  Duration nextDelay(int attempt) {
    calls++;
    return const Duration(milliseconds: 10);
  }

  @override
  void reset() {}
}

class _RecoveryClient extends http.BaseClient {
  _RecoveryClient() {
    first = StreamController<List<int>>(
      onCancel: () => firstCancellation.future,
    );
  }

  // ignore: close_sinks
  late final StreamController<List<int>> first;
  // ignore: close_sinks
  final second = StreamController<List<int>>.broadcast();
  final firstCancellation = Completer<void>();
  final secondRequest = Completer<void>();
  int requests = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests++;
    if (requests == 2) {
      secondRequest.complete();
    }
    return http.StreamedResponse(
      requests == 1 ? first.stream : second.stream,
      200,
    );
  }
}

void main() {
  test('open HTTP response fails before EOF and transport remains usable',
      () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final transport = http.Client();
    final release = Completer<void>();
    final handlers = <Future<void>>[];

    Future<void> handle(HttpRequest request) async {
      if (request.uri.path == '/overflow') {
        request.response.headers.contentType =
            ContentType('text', 'event-stream');
        request.response.bufferOutput = false;
        request.response.write(':${'x' * 64}');
        await request.response.flush();
        await release.future;
      } else {
        request.response.write('reused');
      }
      await request.response.close();
    }

    final serving = server.listen((request) {
      handlers.add(handle(request));
    });
    StreamSubscription<SseMessage>? subscription;
    final client = SseClient(httpClient: transport, maxLineCodeUnits: 32);
    try {
      final base = 'http://${server.address.address}:${server.port}';
      final response = await transport
          .send(http.Request('GET', Uri.parse('$base/overflow')));
      final error = Completer<Object>();
      subscription = client.parseStream(response.stream).listen(
            (_) => fail('partial message escaped'),
            onError: error.complete,
          );
      expect(
        await error.future.timeout(const Duration(seconds: 3)),
        isA<FormatException>(),
      );
      expect(release.isCompleted, isFalse);
      await subscription.cancel();
      expect((await transport.get(Uri.parse('$base/reuse'))).body, 'reused');
      expect(client.lastEventId, isNull);
    } finally {
      await subscription?.cancel();
      if (!release.isCompleted) {
        release.complete();
      }
      await client.close();
      transport.close();
      await serving.cancel();
      await server.close(force: true);
      await Future.wait(handlers);
    }
  });

  test('connect forwards line cap and close prevents reconnect', () async {
    final transport = _ControlledClient();
    final cancelled = Completer<void>();
    transport.source.onCancel = cancelled.complete;
    final client = SseClient(
      httpClient: transport,
      maxLineCodeUnits: 8,
      backoffStrategy: const ConstantBackoff(Duration(milliseconds: 200)),
    );
    final messages = <SseMessage>[];
    final subscription = client
        .connect(Uri.parse('http://synthetic.invalid'))
        .listen(messages.add);
    try {
      transport.source.add(utf8.encode('data: ok\n\n:${'x' * 8}'));
      await cancelled.future.timeout(const Duration(seconds: 3));
      expect(messages.single.data, 'ok');
      await client.close();
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(transport.requests, 1);
      expect(transport.closed, isFalse);
    } finally {
      await subscription.cancel();
      await client.close();
      await transport.source.close();
      transport.close();
    }
  });

  test('connect schedules one recovery after parser overflow', () async {
    final transport = _RecoveryClient();
    final backoff = _CountingBackoff();
    final client = SseClient(
      httpClient: transport,
      maxLineCodeUnits: 8,
      backoffStrategy: backoff,
    );
    final message = Completer<SseMessage>();
    final subscription = client
        .connect(Uri.parse('http://synthetic.invalid'))
        .listen(message.complete);
    try {
      transport.first.add(utf8.encode(':${'x' * 9}'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(transport.requests, 1);
      transport.firstCancellation.complete();
      await transport.secondRequest.future.timeout(const Duration(seconds: 1));
      await Future<void>.delayed(Duration.zero);
      transport.second.add(utf8.encode('data: x\n\n'));
      expect(
        (await message.future.timeout(const Duration(seconds: 3))).data,
        'x',
      );
      expect(backoff.calls, 1);
      expect(transport.requests, 2);
      await client.close();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(transport.requests, 2);
    } finally {
      await subscription.cancel();
      await client.close();
      if (!transport.firstCancellation.isCompleted) {
        transport.firstCancellation.complete();
      }
      await transport.first.close();
      await transport.second.close();
      transport.close();
    }
  });
}
