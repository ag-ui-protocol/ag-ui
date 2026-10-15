import 'dart:convert';

import 'package:agui/agui.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

import 'fixture.dart';

/// The Dart conformance lane: every shared fixture stream, replayed as SSE
/// frames through a mock HTTP client into a real HttpAgent, asserted against
/// the outcome the specification requires.
///
/// The frames arrive the way a producer would send them, so this exercises
/// the whole consumer: the SSE parser, the era shims, the compatibility
/// boundary, enforcement, chunk expansion, verification and the reducer.
/// The TypeScript and .NET lanes read the same files and assert the same
/// expectations.

/// Deep subset match: every key the expectation names must be present and
/// equal, and keys it does not name are ignored. An expected array must
/// match an actual array of the same length, element by element; an
/// expected object must meet an object, never an array.
bool matchesSubset(Object? actual, Object? expected) {
  if (expected is List) {
    if (actual is! List || actual.length != expected.length) return false;
    for (var i = 0; i < expected.length; i++) {
      if (!matchesSubset(actual[i], expected[i])) return false;
    }
    return true;
  }
  if (expected is Map) {
    if (actual is! Map) return false;
    for (final entry in expected.entries) {
      if (!actual.containsKey(entry.key)) return false;
      if (!matchesSubset(actual[entry.key], entry.value)) return false;
    }
    return true;
  }
  return actual == expected;
}

/// Whether a dot/index path exists at all — an explicit null still exists.
bool pathExists(Object? value, String path) {
  Object? node = value;
  for (final key in path.split('.')) {
    if (node is List) {
      final index = int.tryParse(key);
      if (index == null || index < 0 || index >= node.length) return false;
      node = node[index];
      continue;
    }
    if (node is! Map || !node.containsKey(key)) return false;
    node = node[key];
  }
  return true;
}

/// Reads a dot/index path; null when it does not exist.
Object? readPath(Object? value, String path) {
  Object? node = value;
  for (final key in path.split('.')) {
    if (node is List) {
      final index = int.tryParse(key);
      if (index == null || index < 0 || index >= node.length) return null;
      node = node[index];
      continue;
    }
    if (node is! Map) return null;
    node = node[key];
  }
  return node;
}

final class ReplayResult {
  ReplayResult({
    required this.eventTypes,
    required this.events,
    required this.outcome,
    required this.warnings,
    required this.messages,
    required this.state,
    this.error,
    this.runError,
    this.request,
  });

  final List<String> eventTypes;
  final List<Map<String, Object?>> events;
  final String outcome;
  final String? error;
  final String? runError;
  final List<String> warnings;
  final List<Map<String, Object?>> messages;
  final Object? state;
  final Map<String, Object?>? request;
}

Future<ReplayResult> replay(StreamFixture fixture) async {
  Map<String, Object?>? request;
  final client = MockClient.streaming((req, body) async {
    request =
        (jsonDecode(await body.bytesToString()) as Map).cast<String, Object?>();
    // Replayed verbatim: these are the bytes a producer would have sent,
    // including the ones no conforming producer would.
    final frames =
        fixture.stream.map((e) => 'data: ${jsonEncode(e)}\n\n').join();
    return http.StreamedResponse(
      Stream.value(utf8.encode(frames)),
      200,
      headers: {'content-type': 'text/event-stream'},
    );
  });

  final warnings = <String>[];
  // The Dart input is typed, so a fixture message enters through the
  // client's own legacy decoder: a retired binary part is upgraded there,
  // the way the TypeScript client upgrades its loosely typed input on the
  // way out. A message that still cannot be decoded is left out of the run,
  // which the fixture's override must then pin.
  final initialMessages = <Message>[];
  for (final raw in (fixture.input?['messages'] as List?) ?? const []) {
    try {
      initialMessages.add(
        decodeLegacyMessage(
          (raw as Map).cast<String, Object?>(),
          warn: warnings.add,
        ),
      );
    } on AguiDecodeException catch (e) {
      warnings.add('[lane] input message left out of the run: $e');
    }
  }
  final agent = HttpAgent(
    url: Uri.parse('http://conformance.invalid/${fixture.name}'),
    client: client,
    threadId: 't-${fixture.name}',
    initialMessages: initialMessages,
    maxProtocolVersion: fixture.maxProtocolVersion,
    onWarning: warnings.add,
  );

  final eventTypes = <String>[];
  final events = <Map<String, Object?>>[];
  String? runError;
  var outcome = 'completed';
  String? error;
  try {
    await for (final event in agent.run(
      tools: [
        for (final raw in (fixture.input?['tools'] as List?) ?? const [])
          Tool.fromJson((raw as Map).cast<String, Object?>()),
      ],
      context: [
        for (final raw in (fixture.input?['context'] as List?) ?? const [])
          Context.fromJson((raw as Map).cast<String, Object?>()),
      ],
      forwardedProps: fixture.input?['forwardedProps'],
    )) {
      eventTypes.add(event.type.wireName);
      events.add(event.toJson());
      if (event is RunErrorEvent) runError = event.message;
    }
  } catch (thrown) {
    outcome = 'failed';
    error = thrown.toString();
  }

  return ReplayResult(
    eventTypes: eventTypes,
    events: events,
    outcome: outcome,
    error: error,
    runError: runError,
    warnings: warnings.where((w) => !w.startsWith('[lane]')).toList(),
    messages: [for (final m in agent.messages) m.toJson()],
    state: agent.state,
    request: request,
  );
}

void assertExpectation(ReplayResult result, Map<String, Object?> expectation) {
  if (expectation.containsKey('outcome')) {
    expect(
      result.outcome,
      expectation['outcome'],
      reason:
          result.error == null
              ? 'expected the run to be ${expectation['outcome']}'
              : 'expected the run to be ${expectation['outcome']} — it failed '
                  'with: ${result.error}',
    );
  }
  if (expectation.containsKey('eventTypes')) {
    expect(
      result.eventTypes,
      expectation['eventTypes'],
      reason: 'the events delivered to application code',
    );
  }
  for (final type in (expectation['eventTypesAbsent'] as List?) ?? const []) {
    expect(
      result.eventTypes,
      isNot(contains(type)),
      reason: '$type must not reach application code',
    );
  }
  for (final entry
      in ((expectation['eventPaths'] as Map?) ?? const {}).entries) {
    final path = entry.key as String;
    expect(
      pathExists(result.events, path),
      isTrue,
      reason: '$path must exist in the delivered events',
    );
    expect(
      readPath(result.events, path),
      entry.value,
      reason: 'delivered event at $path',
    );
  }
  for (final path in (expectation['eventAbsentPaths'] as List?) ?? const []) {
    expect(
      pathExists(result.events, path as String),
      isFalse,
      reason: '$path must NOT exist in the delivered events',
    );
  }
  if (expectation.containsKey('errorContains')) {
    expect(result.error ?? '', contains(expectation['errorContains']));
  }
  if (expectation.containsKey('runError')) {
    final runError = expectation['runError'];
    if (runError == false) {
      expect(
        result.runError,
        isNull,
        reason: 'the run must not report a failure',
      );
    } else {
      expect(
        result.runError,
        isNotNull,
        reason: 'the run was expected to report its own failure',
      );
      if (runError is String) expect(result.runError ?? '', contains(runError));
    }
  }
  for (final substring in (expectation['warnings'] as List?) ?? const []) {
    expect(
      result.warnings.any((w) => w.contains(substring as String)),
      isTrue,
      reason:
          'expected a warning containing ${jsonEncode(substring)}; saw: '
          '${result.warnings.isEmpty ? '(none)' : result.warnings.map(jsonEncode).join(', ')}',
    );
  }
  if (expectation['noWarnings'] == true) {
    expect(
      result.warnings,
      isEmpty,
      reason: 'a conformant stream must not make a client complain',
    );
  }
  if (expectation.containsKey('messageCount')) {
    expect(result.messages, hasLength(expectation['messageCount'] as int));
  }
  if (expectation.containsKey('messages')) {
    expect(
      matchesSubset(result.messages, expectation['messages']),
      isTrue,
      reason:
          'messages did not match:\nexpected subset '
          '${jsonEncode(expectation['messages'])}\nactual '
          '${jsonEncode(result.messages)}',
    );
  }
  if (expectation.containsKey('state')) {
    expect(
      matchesSubset(result.state, expectation['state']),
      isTrue,
      reason:
          'state did not match:\nexpected subset '
          '${jsonEncode(expectation['state'])}\nactual ${jsonEncode(result.state)}',
    );
  }
  if (expectation.containsKey('request')) {
    expect(
      matchesSubset(result.request, expectation['request']),
      isTrue,
      reason:
          'the request the client sent did not match:\nexpected subset '
          '${jsonEncode(expectation['request'])}\nactual '
          '${jsonEncode(result.request)}',
    );
  }
  for (final path in (expectation['requestAbsentPaths'] as List?) ?? const []) {
    expect(
      pathExists(result.request, path as String),
      isFalse,
      reason: '$path must be absent from the request the client sent',
    );
  }
}

void main() {
  final fixtures = loadFixtures();

  test('has fixtures to run', () {
    expect(fixtures, isNotEmpty);
  });

  for (final fixture in fixtures) {
    test('${fixture.area}: ${fixture.name} — ${fixture.description}', () async {
      final result = await replay(fixture);
      assertExpectation(result, resolveExpectation(fixture, 'dart'));
    });
  }
}
