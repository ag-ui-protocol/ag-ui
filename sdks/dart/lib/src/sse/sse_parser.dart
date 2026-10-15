import 'dart:convert';

import '../errors.dart';

/// The most data one event may carry, in UTF-16 code units: the same 10 MB
/// cap the TypeScript client's SSE reader applies, so a producer that never
/// sends a blank line cannot grow the buffer without bound.
const int maxSseEventLength = 10 * 1024 * 1024;

/// One server-sent event, as the WHATWG EventSource algorithm assembles it.
final class SseEvent {
  const SseEvent({required this.data, this.event, this.id, this.retry});

  /// The `data` lines joined with a newline.
  final String data;

  /// The `event` field, when the frame carried one.
  final String? event;

  /// The `id` field, when the frame carried one.
  final String? id;

  /// The `retry` field, when the frame carried a well-formed one.
  final int? retry;
}

/// Parses a byte stream of server-sent events.
///
/// Bytes are decoded as UTF-8 before lines are split, so a multi-byte
/// sequence cut across two chunks still decodes; `\n`, `\r\n` and `\r` all end
/// a line. A line starting with `:` is a comment. A blank line dispatches the
/// event under assembly when it has data. An event still open when the
/// stream ends is dispatched too, as the TypeScript client does — the WHATWG
/// algorithm drops it, but a producer that closes right after its last
/// `data:` line has sent that event, and losing RUN_FINISHED that way would
/// leave a run that nothing notices ended. Unknown fields are ignored. An
/// event larger than [maxSseEventLength] fails the stream.
Stream<SseEvent> parseSse(Stream<List<int>> bytes) async* {
  final lines = bytes.transform(utf8.decoder).transform(const LineSplitter());
  final data = <String>[];
  String? event;
  String? id;
  int? retry;
  var sawData = false;
  var dataLength = 0;

  await for (final line in lines) {
    if (line.isEmpty) {
      if (sawData) {
        yield SseEvent(
          data: data.join('\n'),
          event: event,
          id: id,
          retry: retry,
        );
      }
      data.clear();
      event = null;
      id = null;
      retry = null;
      sawData = false;
      dataLength = 0;
      continue;
    }
    if (line.startsWith(':')) continue;
    final colon = line.indexOf(':');
    final field = colon == -1 ? line : line.substring(0, colon);
    var value = colon == -1 ? '' : line.substring(colon + 1);
    if (value.startsWith(' ')) value = value.substring(1);
    switch (field) {
      case 'data':
        data.add(value);
        sawData = true;
        dataLength += value.length + 1;
        if (dataLength > maxSseEventLength) {
          throw AguiProtocolException(
            'SSE event exceeds $maxSseEventLength characters of data without '
            'a terminating blank line',
          );
        }
      case 'event':
        event = value;
      case 'id':
        id = value;
      case 'retry':
        final parsed = int.tryParse(value);
        if (parsed != null && RegExp(r'^\d+$').hasMatch(value)) retry = parsed;
      default:
        break;
    }
  }
  if (sawData) {
    yield SseEvent(data: data.join('\n'), event: event, id: id, retry: retry);
  }
}
