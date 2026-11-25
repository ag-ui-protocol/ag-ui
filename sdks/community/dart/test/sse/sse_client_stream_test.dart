import 'dart:async';
import 'dart:convert';

import 'package:ag_ui/src/sse/backoff_strategy.dart';
import 'package:ag_ui/src/sse/sse_client.dart';
import 'package:ag_ui/src/sse/sse_message.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

void main() {
  group('SseClient connection lifecycle', () {
    final oldUrl = Uri.parse('https://synthetic.invalid/old');
    final newUrl = Uri.parse('https://synthetic.invalid/new');
    const timeout = Duration(seconds: 3);

    test('close waits for retry cleanup and reopen uses only the new endpoint',
        () async {
      final cancellationStarted = Completer<void>();
      final releaseCancellation = Completer<void>();
      final oldBody = StreamController<List<int>>(
        onCancel: () {
          cancellationStarted.complete();
          return releaseCancellation.future;
        },
      );
      final newBody = StreamController<List<int>>();
      final requests = <http.BaseRequest>[];
      final transport = MockClient.streaming((request, _) async {
        requests.add(request);
        return http.StreamedResponse(
          requests.length == 1 ? oldBody.stream : newBody.stream,
          200,
        );
      });
      final client = SseClient(
        httpClient: transport,
        backoffStrategy: const ConstantBackoff(Duration.zero),
      );
      final oldEvent = Completer<SseMessage>();
      final first = client.connect(oldUrl).listen(oldEvent.complete);
      StreamSubscription<SseMessage>? second;
      addTearDown(() async {
        if (!releaseCancellation.isCompleted) {
          releaseCancellation.complete();
        }
        await first.cancel();
        await second?.cancel();
        await client.close();
        unawaited(oldBody.close());
        unawaited(newBody.close());
        transport.close();
      });

      oldBody.add(utf8.encode('id: old-id\ndata: from-old\n\n'));
      expect((await oldEvent.future.timeout(timeout)).data, 'from-old');
      oldBody.add([0xFF]);
      await cancellationStarted.future.timeout(timeout);
      // Let the zero-delay retry enter its pending subscription cancellation.
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(requests.map((request) => request.url), [oldUrl]);

      final newEvent = Completer<SseMessage>();
      var closed = false;
      var secondCloseReturned = false;
      final closing = client.close().then((_) => closed = true);
      final alsoClosing =
          client.close().then((_) => secondCloseReturned = true);
      final reopen = Future.wait([closing, alsoClosing]).then((_) {
        second = client.connect(newUrl).listen(newEvent.complete);
      });
      await Future<void>.delayed(Duration.zero);
      final closedBeforeCleanup = closed || secondCloseReturned;
      releaseCancellation.complete();
      await reopen.timeout(timeout);
      newBody.add(utf8.encode('data: from-reopen\n\n'));
      expect((await newEvent.future.timeout(timeout)).data, 'from-reopen');
      expect(requests.map((request) => request.url), [oldUrl, newUrl]);
      expect(requests.last.headers['last-event-id'], isNull);
      expect(closedBeforeCleanup, isFalse);
    });

    test('a late HTTP response cannot deliver events after close and reopen',
        () async {
      final sentOldRequest = Completer<void>();
      final sentNewRequest = Completer<void>();
      final oldResponse = Completer<http.StreamedResponse>();
      final oldBodyCancelled = Completer<void>();
      final oldBody = StreamController<List<int>>(
        onCancel: oldBodyCancelled.complete,
      );
      final newBody = StreamController<List<int>>();
      final requests = <Uri>[];
      final transport = MockClient.streaming((request, _) async {
        requests.add(request.url);
        if (request.url == oldUrl) {
          sentOldRequest.complete();
          return oldResponse.future;
        }
        sentNewRequest.complete();
        return http.StreamedResponse(newBody.stream, 200);
      });
      final client = SseClient(httpClient: transport);
      final first = client.connect(oldUrl).listen((_) {});
      StreamSubscription<SseMessage>? second;
      addTearDown(() async {
        if (!oldResponse.isCompleted) {
          oldResponse.complete(http.StreamedResponse(oldBody.stream, 200));
        }
        await first.cancel();
        await second?.cancel();
        await client.close();
        unawaited(oldBody.close());
        unawaited(newBody.close());
        transport.close();
      });

      await sentOldRequest.future.timeout(timeout);
      await client.close().timeout(timeout);
      final received = <String?>[];
      final newEvent = Completer<void>();
      second = client.connect(newUrl).listen((message) {
        received.add(message.data);
        if (message.data == 'from-new') {
          newEvent.complete();
        }
      });
      await sentNewRequest.future.timeout(timeout);
      oldBody.add(utf8.encode('data: stale\n\n'));
      oldResponse.complete(http.StreamedResponse(oldBody.stream, 200));
      newBody.add(utf8.encode('data: from-new\n\n'));
      await newEvent.future.timeout(timeout);
      await oldBodyCancelled.future.timeout(timeout);
      expect(requests, [oldUrl, newUrl]);
      expect(received, ['from-new']);
      expect(client.isConnected, isTrue);
    });
  });

  group('SseClient Stream Parsing', () {
    test('resolves and forwards the line limit', () async {
      final derived = SseClient(maxDataCodeUnits: 8);
      expect(derived.maxLineCodeUnits, 15);
      await expectLater(
        derived.parseStream(
          Stream.value(utf8.encode(':123456789012345\ndata: 12345678')),
        ),
        emitsError(isA<FormatException>()),
      );

      final overridden = SseClient(
        maxDataCodeUnits: 8,
        maxLineCodeUnits: 16,
      );
      expect(overridden.maxLineCodeUnits, 16);
      expect(
        (await overridden
                .parseStream(
                  Stream.value(
                    utf8.encode(':123456789012345\ndata: 12345678'),
                  ),
                )
                .toList())
            .single
            .data,
        '12345678',
      );
    });

    test('validates limits before allocating a fallback HTTP client', () {
      expect(
        () => SseClient(maxDataCodeUnits: 0),
        throwsArgumentError,
      );
      expect(
        () => SseClient(maxLineCodeUnits: 0),
        throwsArgumentError,
      );
    });

    test('parseStream parses properly formatted SSE messages', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Send properly formatted SSE messages
      // Message 1: Simple data
      controller.add(utf8.encode('data: Hello\n'));
      controller.add(utf8.encode('\n')); // Empty line triggers dispatch

      // Message 2: Event with data
      controller.add(utf8.encode('event: custom\n'));
      controller.add(utf8.encode('data: World\n'));
      controller.add(utf8.encode('\n')); // Empty line triggers dispatch

      // Message 3: Message with ID
      controller.add(utf8.encode('id: msg-1\n'));
      controller.add(utf8.encode('data: Test\n'));
      controller.add(utf8.encode('\n')); // Empty line triggers dispatch

      // Close the stream
      await controller.close();

      // Get the messages
      final messages = await messagesFuture;

      expect(messages.length, equals(3));

      // Check Message 1
      expect(messages[0].data, equals('Hello'));
      expect(messages[0].event, isNull);
      expect(messages[0].id, isNull);

      // Check Message 2
      expect(messages[1].data, equals('World'));
      expect(messages[1].event, equals('custom'));

      // Check Message 3
      expect(messages[2].data, equals('Test'));
      expect(messages[2].id, equals('msg-1'));
    });

    test('parseStream handles multi-line data fields', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Send message with multiple data fields
      controller.add(utf8.encode('data: Line 1\n'));
      controller.add(utf8.encode('data: Line 2\n'));
      controller.add(utf8.encode('data: Line 3\n'));
      controller.add(utf8.encode('\n')); // Empty line triggers dispatch

      await controller.close();

      final messages = await messagesFuture;

      expect(messages.length, equals(1));
      // Multiple data fields are joined with newlines
      expect(messages[0].data, equals('Line 1\nLine 2\nLine 3'));
    });

    test('parseStream handles retry field', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Send message with retry field
      controller.add(utf8.encode('retry: 5000\n'));
      controller.add(utf8.encode('data: Retry message\n'));
      controller.add(utf8.encode('\n'));

      await controller.close();

      final messages = await messagesFuture;

      expect(messages.length, equals(1));
      expect(messages[0].data, equals('Retry message'));
      expect(messages[0].retry, equals(Duration(milliseconds: 5000)));
    });

    test('parseStream ignores comments', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Send message with comments
      controller.add(utf8.encode(': This is a comment\n'));
      controller.add(utf8.encode('data: Real data\n'));
      controller.add(utf8.encode(': Another comment\n'));
      controller.add(utf8.encode('\n'));

      await controller.close();

      final messages = await messagesFuture;

      expect(messages.length, equals(1));
      expect(messages[0].data, equals('Real data'));
    });

    test('parseStream handles empty data field', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Send message with empty data
      controller.add(utf8.encode('data:\n')); // Empty data field
      controller.add(utf8.encode('\n'));

      await controller.close();

      final messages = await messagesFuture;

      expect(messages.length, equals(1));
      expect(messages[0].data, equals('')); // Empty string, not null
    });

    test('parseStream skips messages without data field', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Send message without data field (should be ignored)
      controller.add(utf8.encode('event: ping\n'));
      controller.add(utf8.encode('id: 1\n'));
      controller.add(utf8.encode('\n'));

      // Send valid message
      controller.add(utf8.encode('data: Valid message\n'));
      controller.add(utf8.encode('\n'));

      await controller.close();

      final messages = await messagesFuture;

      // Only the message with data field should be dispatched
      expect(messages.length, equals(1));
      expect(messages[0].data, equals('Valid message'));
    });

    test('parseStream handles field without colon', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Field without colon is treated as field name with empty value
      controller.add(utf8.encode('data\n')); // data field with empty value
      controller.add(utf8.encode('\n'));

      await controller.close();

      final messages = await messagesFuture;

      expect(messages.length, equals(1));
      expect(messages[0].data, equals('')); // Empty value
    });

    test('parseStream removes single leading space from field value', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // SSE spec: single leading space after colon is removed
      controller.add(utf8.encode('data: With space\n'));
      controller
          .add(utf8.encode('data:  Two spaces\n')); // Only first space removed
      controller.add(utf8.encode('data:No space\n'));
      controller.add(utf8.encode('\n'));

      await controller.close();

      final messages = await messagesFuture;

      expect(messages.length, equals(1));
      expect(messages[0].data, equals('With space\n Two spaces\nNo space'));
    });
  });
}
