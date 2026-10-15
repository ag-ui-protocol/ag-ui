import 'dart:convert';

import 'package:http/http.dart' as http;

import '../errors.dart';
import '../generated/models.dart';
import '../sse/sse_parser.dart';
import 'agent.dart';

/// An agent reached over HTTP: the request is posted as JSON and the events
/// come back as server-sent events.
class HttpAgent extends AbstractAgent {
  HttpAgent({
    required this.url,
    Map<String, String> headers = const {},
    http.Client? client,
    super.agentId,
    super.threadId,
    super.initialMessages,
    super.initialState,
    super.description,
    super.maxProtocolVersion,
    super.onWarning,
  }) : headers = Map.of(headers),
       _client = client;

  final Uri url;

  /// Sent on every request, before the content-type and accept headers.
  final Map<String, String> headers;

  http.Client? _client;

  /// The HTTP client requests go through. Created on first use when none was
  /// injected; never closed by the agent.
  http.Client get client => _client ??= http.Client();

  @override
  Stream<Map<String, Object?>> connect(RunAgentInput input) async* {
    final request =
        http.Request('POST', url)
          ..headers.addAll(headers)
          ..headers['content-type'] = 'application/json'
          ..headers['accept'] = 'text/event-stream'
          ..body = jsonEncode(input.toJson());
    final response = await client.send(request);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final body = await response.stream.bytesToString();
      throw AguiHttpException(
        'HTTP ${response.statusCode} from $url',
        statusCode: response.statusCode,
        body: body,
      );
    }
    await for (final frame in parseSse(response.stream)) {
      final decoded = jsonDecode(frame.data);
      if (decoded is! Map) {
        throw AguiDecodeException(
          definition: 'Event',
          path: '',
          message: 'expected object, received ${_kindOf(decoded)}',
        );
      }
      yield decoded.cast<String, Object?>();
    }
  }
}

String _kindOf(Object? value) => switch (value) {
  null => 'null',
  String() => 'string',
  bool() => 'boolean',
  num() => 'number',
  List() => 'array',
  _ => value.runtimeType.toString(),
};
