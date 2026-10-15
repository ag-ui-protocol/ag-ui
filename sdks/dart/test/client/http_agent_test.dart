import 'dart:convert';

import 'package:agui/agui.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// A client serving [events] as SSE frames, handing each request's method,
/// headers and decoded JSON body to [onRequest].
MockClient streamingClient(
  List<Map<String, Object?>> events, {
  void Function(http.BaseRequest request, Map<String, Object?> body)? onRequest,
}) => MockClient.streaming((request, bodyStream) async {
  final body = jsonDecode(await bodyStream.bytesToString());
  onRequest?.call(request, (body as Map).cast<String, Object?>());
  final frames = events.map((e) => 'data: ${jsonEncode(e)}\n\n').join();
  return http.StreamedResponse(
    Stream.value(utf8.encode(frames)),
    200,
    headers: {'content-type': 'text/event-stream'},
  );
});

const run = [
  {'type': 'RUN_STARTED', 'threadId': 't', 'runId': 'r'},
  {'type': 'RUN_FINISHED', 'threadId': 't', 'runId': 'r'},
];

void main() {
  test('posts the input and yields decoded events', () async {
    http.BaseRequest? seen;
    Map<String, Object?>? body;
    final agent = HttpAgent(
      url: Uri.parse('http://x/agent'),
      headers: const {'authorization': 'Bearer t'},
      client: streamingClient(
        run,
        onRequest: (r, b) {
          seen = r;
          body = b;
        },
      ),
      threadId: 't',
    );
    final events = await agent.run(runId: 'r').toList();
    expect(events.map((e) => e.type), [
      EventType.runStarted,
      EventType.runFinished,
    ]);
    expect(seen!.method, 'POST');
    expect(seen!.headers['accept'], 'text/event-stream');
    expect(seen!.headers['content-type'], startsWith('application/json'));
    expect(seen!.headers['authorization'], 'Bearer t');
    expect(body!['threadId'], 't');
    expect(body!['runId'], 'r');
    expect(body!['protocolVersion'], '1.0');
    expect(body!['messages'], isEmpty);
  });

  test(
    'a pinned pre-1.0 peer gets no protocolVersion on the request',
    () async {
      Map<String, Object?>? body;
      final agent = HttpAgent(
        url: Uri.parse('http://x/agent'),
        client: streamingClient(run, onRequest: (_, b) => body = b),
        threadId: 't',
        maxProtocolVersion: '0.0.57',
      );
      await agent.runAgent(runId: 'r');
      expect(body!.containsKey('protocolVersion'), isFalse);
    },
  );

  test('a non-2xx response is an AguiHttpException on the stream', () async {
    final agent = HttpAgent(
      url: Uri.parse('http://x'),
      client: MockClient((_) async => http.Response('nope', 503)),
    );
    await expectLater(
      agent.run().toList(),
      throwsA(
        isA<AguiHttpException>()
            .having((e) => e.statusCode, 'statusCode', 503)
            .having((e) => e.body, 'body', 'nope'),
      ),
    );
    expect(agent.isRunning, isFalse);
  });

  test('activity messages are not sent as input', () async {
    Map<String, Object?>? body;
    final agent = HttpAgent(
      url: Uri.parse('http://x/agent'),
      client: streamingClient(run, onRequest: (_, b) => body = b),
      threadId: 't',
      initialMessages: const [
        UserMessage(id: 'u', content: 'hi'),
        ActivityMessage(id: 'a', activityType: 'x', content: {}),
      ],
    );
    await agent.runAgent(runId: 'r');
    expect((body!['messages'] as List).map((m) => (m as Map)['id']), ['u']);
  });
}
