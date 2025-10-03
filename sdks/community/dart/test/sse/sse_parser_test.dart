import 'dart:async';
import 'dart:convert';

import 'package:ag_ui/src/sse/sse_parser.dart';
import 'package:test/test.dart';

void main() {
  group('SseParser', () {
    late SseParser parser;

    setUp(() {
      parser = SseParser();
    });

    group('parseLines', () {
      test('parses simple message with data only', () async {
        final lines = Stream.fromIterable([
          'data: hello world',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 1);
        expect(messages[0].data, 'hello world');
        expect(messages[0].event, isNull);
        expect(messages[0].id, isNull);
      });

      test('parses message with event type', () async {
        final lines = Stream.fromIterable([
          'event: user-connected',
          'data: {"username": "alice"}',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 1);
        expect(messages[0].event, 'user-connected');
        expect(messages[0].data, '{"username": "alice"}');
      });

      test('parses message with id', () async {
        final lines = Stream.fromIterable([
          'id: 123',
          'data: test message',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 1);
        expect(messages[0].id, '123');
        expect(messages[0].data, 'test message');
      });

      test('parses message with retry', () async {
        final lines = Stream.fromIterable([
          'retry: 5000',
          'data: reconnect test',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 1);
        expect(messages[0].retry, Duration(milliseconds: 5000));
        expect(messages[0].data, 'reconnect test');
      });

      test('handles multi-line data', () async {
        final lines = Stream.fromIterable([
          'data: line 1',
          'data: line 2',
          'data: line 3',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 1);
        expect(messages[0].data, 'line 1\nline 2\nline 3');
      });

      test('ignores comments', () async {
        final lines = Stream.fromIterable([
          ': this is a comment',
          'data: actual data',
          ': another comment',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 1);
        expect(messages[0].data, 'actual data');
      });

      test('handles field with no colon', () async {
        final lines = Stream.fromIterable([
          'data',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        // Per WHATWG spec, a field with no colon treats the entire line as the field name
        // with an empty value. 'data' field with empty value should dispatch a message.
        expect(messages.length, 1);
        expect(messages[0].data, '');
      });

      test('removes single leading space from value', () async {
        final lines = Stream.fromIterable([
          'data: value with space',
          'event:  two spaces',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 1);
        expect(messages[0].data, 'value with space');
        expect(messages[0].event, ' two spaces'); // Only first space removed
      });

      test('handles multiple messages', () async {
        final lines = Stream.fromIterable([
          'data: message 1',
          '',
          'data: message 2',
          '',
          'data: message 3',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 3);
        expect(messages[0].data, 'message 1');
        expect(messages[1].data, 'message 2');
        expect(messages[2].data, 'message 3');
      });

      test('ignores empty events (no data)', () async {
        final lines = Stream.fromIterable([
          'event: empty',
          '',
          'data: has data',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 1);
        expect(messages[0].data, 'has data');
      });

      test('preserves lastEventId across messages', () async {
        final lines = Stream.fromIterable([
          'id: 100',
          'data: first',
          '',
          'data: second',
          '',
          'id: 200',
          'data: third',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 3);
        expect(messages[0].id, '100');
        expect(messages[1].id, '100'); // Preserved from previous
        expect(messages[2].id, '200');
        expect(parser.lastEventId, '200');
      });

      test('ignores id with newlines', () async {
        final lines = Stream.fromIterable([
          'id: 123\n456',
          'data: test',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 1);
        expect(messages[0].id, isNull);
      });

      test('ignores invalid retry values', () async {
        final lines = Stream.fromIterable([
          'retry: not-a-number',
          'data: test1',
          '',
          'retry: -1000',
          'data: test2',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 2);
        expect(messages[0].retry, isNull);
        expect(messages[1].retry, isNull);
      });

      test('handles unknown fields', () async {
        final lines = Stream.fromIterable([
          'unknown: field',
          'data: test',
          'another: unknown',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 1);
        expect(messages[0].data, 'test');
      });

      test('dispatches remaining message at end of stream', () async {
        final lines = Stream.fromIterable([
          'data: incomplete message',
          // No empty line to dispatch
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 1);
        expect(messages[0].data, 'incomplete message');
      });
    });

    group('parseBytes', () {
      test('handles UTF-8 encoded bytes', () async {
        final text = 'data: hello 世界\n\n';
        final bytes = Stream.value(utf8.encode(text));

        final messages = await parser.parseBytes(bytes).toList();
        expect(messages.length, 1);
        expect(messages[0].data, 'hello 世界');
      });

      test('removes BOM if present', () async {
        // UTF-8 BOM + data
        final bytesWithBom = [0xEF, 0xBB, 0xBF, ...utf8.encode('data: test\n\n')];
        final stream = Stream.value(bytesWithBom);

        final messages = await parser.parseBytes(stream).toList();
        expect(messages.length, 1);
        expect(messages[0].data, 'test');
      });

      test('handles chunked input', () async {
        final chunks = [
          utf8.encode('da'),
          utf8.encode('ta: hel'),
          utf8.encode('lo\n'),
          utf8.encode('\n'),
        ];
        final stream = Stream.fromIterable(chunks);

        final messages = await parser.parseBytes(stream).toList();
        expect(messages.length, 1);
        expect(messages[0].data, 'hello');
      });

      test('handles different line endings', () async {
        // Test with \r\n (CRLF)
        final crlfBytes = utf8.encode('data: line1\r\ndata: line2\r\n\r\n');
        final crlfStream = Stream.value(crlfBytes);
        
        final crlfMessages = await parser.parseBytes(crlfStream).toList();
        expect(crlfMessages.length, 1);
        expect(crlfMessages[0].data, 'line1\nline2');

        // Reset parser for next test
        parser = SseParser();

        // Test with \n (LF)
        final lfBytes = utf8.encode('data: line1\ndata: line2\n\n');
        final lfStream = Stream.value(lfBytes);
        
        final lfMessages = await parser.parseBytes(lfStream).toList();
        expect(lfMessages.length, 1);
        expect(lfMessages[0].data, 'line1\nline2');
      });
    });

    group('complex scenarios', () {
      test('handles real-world SSE stream', () async {
        final lines = Stream.fromIterable([
          ': ping',
          '',
          'event: user-joined',
          'id: evt-001',
          'retry: 10000',
          'data: {"user": "alice", "timestamp": 1234567890}',
          '',
          ': keepalive',
          '',
          'event: message',
          'id: evt-002',
          'data: {"from": "alice",',
          'data:  "text": "Hello, world!",',
          'data:  "timestamp": 1234567891}',
          '',
          'data: plain text message',
          '',
        ]);

        final messages = await parser.parseLines(lines).toList();
        expect(messages.length, 3);

        expect(messages[0].event, 'user-joined');
        expect(messages[0].id, 'evt-001');
        expect(messages[0].retry, Duration(milliseconds: 10000));
        expect(messages[0].data, '{"user": "alice", "timestamp": 1234567890}');

        expect(messages[1].event, 'message');
        expect(messages[1].id, 'evt-002');
        expect(messages[1].data, '{"from": "alice",\n "text": "Hello, world!",\n "timestamp": 1234567891}');

        expect(messages[2].event, isNull);
        expect(messages[2].id, 'evt-002'); // Preserved from previous
        expect(messages[2].data, 'plain text message');
      });
    });
  });
}