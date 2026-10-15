import 'dart:convert';

import 'package:agui/agui.dart';
import 'package:test/test.dart';

Stream<List<int>> bytes(List<String> chunks) =>
    Stream.fromIterable(chunks.map(utf8.encode));

void main() {
  test('parses one event per blank line and joins data lines', () async {
    final events = await parseSse(bytes(['data: a\ndata: b\n\n'])).toList();
    expect(events.single.data, 'a\nb');
  });

  test('handles CRLF and CR line endings', () async {
    final events =
        await parseSse(
          bytes(['event: x\r\ndata: 1\r\n\r\ndata: 2\r\r']),
        ).toList();
    expect(events.map((e) => e.data), ['1', '2']);
    expect(events.first.event, 'x');
  });

  test('reassembles a UTF-8 sequence split across chunks', () async {
    final encoded = utf8.encode('data: é\n\n');
    final events =
        await parseSse(
          Stream.fromIterable([encoded.sublist(0, 7), encoded.sublist(7)]),
        ).toList();
    expect(events.single.data, 'é');
  });

  test('ignores comments and unknown fields', () async {
    final events =
        await parseSse(bytes([': ping\nfoo: bar\ndata: ok\n\n'])).toList();
    expect(events.map((e) => e.data), ['ok']);
  });

  test('an event still open when the stream ends is delivered', () async {
    final events = await parseSse(bytes(['data: a\n\ndata: tail\n'])).toList();
    expect(events.map((e) => e.data), ['a', 'tail']);
  });

  test(
    'a stream ending in a comment or field only delivers nothing more',
    () async {
      final events =
          await parseSse(bytes(['data: a\n\n: bye\nevent: x'])).toList();
      expect(events.map((e) => e.data), ['a']);
    },
  );

  test('an oversized event fails the stream', () {
    final big = 'data: ${'x' * (maxSseEventLength + 1)}\n';
    expect(
      parseSse(bytes([big])).toList(),
      throwsA(isA<AguiProtocolException>()),
    );
  });

  test('a frame split across chunks mid-line still assembles', () async {
    final events =
        await parseSse(bytes(['da', 'ta: he', 'llo\n', '\n'])).toList();
    expect(events.single.data, 'hello');
  });

  test('a field without a colon has an empty value', () async {
    final events = await parseSse(bytes(['data\n\n'])).toList();
    expect(events.single.data, '');
  });
}
