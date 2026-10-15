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

  test(
    'ignores comments and unknown fields, drops an unterminated event',
    () async {
      final events =
          await parseSse(
            bytes([': ping\nfoo: bar\ndata: ok\n\ndata: tail']),
          ).toList();
      expect(events.map((e) => e.data), ['ok']);
    },
  );

  test('strips one leading space only and parses retry', () async {
    final events =
        await parseSse(bytes(['data:  two\nretry: 250\n\n'])).toList();
    expect(events.single.data, ' two');
    expect(events.single.retry, 250);
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
