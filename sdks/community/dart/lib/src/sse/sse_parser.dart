import 'dart:async';
import 'dart:convert';

import 'sse_message.dart';

/// Parses Server-Sent Events according to the WHATWG specification.
class SseParser {
  final _eventBuffer = StringBuffer();
  final _dataBuffer = StringBuffer();
  String? _lastEventId;
  Duration? _retry;
  bool _hasDataField = false;

  /// Parses SSE data and yields messages.
  /// 
  /// The input should be a stream of text lines from an SSE endpoint.
  /// Empty lines trigger message dispatch.
  Stream<SseMessage> parseLines(Stream<String> lines) async* {
    await for (final line in lines) {
      final message = _processLine(line);
      if (message != null) {
        yield message;
      }
    }
    
    // Dispatch any remaining buffered message
    final finalMessage = _dispatchEvent();
    if (finalMessage != null) {
      yield finalMessage;
    }
  }

  /// Parses raw bytes from an SSE stream.
  Stream<SseMessage> parseBytes(Stream<List<int>> bytes) {
    return utf8.decoder
        .bind(bytes)
        .transform(const LineSplitter())
        .transform(StreamTransformer<String, String>.fromHandlers(
          handleData: (String line, EventSink<String> sink) {
            // Remove BOM if present at the start
            if (line.isNotEmpty && line.codeUnitAt(0) == 0xFEFF) {
              line = line.substring(1);
            }
            sink.add(line);
          },
        ))
        .asyncExpand<SseMessage>((String line) {
          final message = _processLine(line);
          return message != null ? Stream.value(message) : Stream.empty();
        });
  }

  /// Process a single line according to SSE spec.
  SseMessage? _processLine(String line) {
    // Empty line dispatches the event
    if (line.isEmpty) {
      return _dispatchEvent();
    }

    // Comment line (starts with ':')
    if (line.startsWith(':')) {
      // Ignore comments
      return null;
    }

    // Field line
    final colonIndex = line.indexOf(':');
    if (colonIndex == -1) {
      // Line is a field name with no value
      _processField(line, '');
    } else {
      final field = line.substring(0, colonIndex);
      var value = line.substring(colonIndex + 1);
      // Remove single leading space if present (per spec)
      if (value.isNotEmpty && value[0] == ' ') {
        value = value.substring(1);
      }
      _processField(field, value);
    }

    return null;
  }

  /// Process a field according to SSE spec.
  void _processField(String field, String value) {
    switch (field) {
      case 'event':
        _eventBuffer.write(value);
        break;
      case 'data':
        _hasDataField = true;
        if (_dataBuffer.isNotEmpty) {
          _dataBuffer.writeln(); // Add newline between data fields
        }
        _dataBuffer.write(value);
        break;
      case 'id':
        // id field doesn't contain newlines
        if (!value.contains('\n') && !value.contains('\r')) {
          _lastEventId = value;
        }
        break;
      case 'retry':
        final milliseconds = int.tryParse(value);
        if (milliseconds != null && milliseconds >= 0) {
          _retry = Duration(milliseconds: milliseconds);
        }
        break;
      default:
        // Unknown field, ignore per spec
        break;
    }
  }

  /// Dispatches the current buffered event.
  SseMessage? _dispatchEvent() {
    // According to WHATWG spec, we need to have received at least one 'data' field
    // to dispatch an event. An empty data buffer means no 'data' field was received.
    // However, 'data' field with empty value should still dispatch (with empty string).
    // We track this by checking if the data buffer has been written to at all.
    
    // For simplicity, we'll dispatch if we have any event-related fields set
    // but only if at least one data field was received (even if empty)
    if (!_hasDataField) {
      _resetBuffers();
      return null;
    }

    final message = SseMessage(
      event: _eventBuffer.isNotEmpty ? _eventBuffer.toString() : null,
      id: _lastEventId,
      data: _dataBuffer.toString(),
      retry: _retry,
    );

    _resetBuffers();
    return message;
  }

  /// Resets the buffers for the next event.
  void _resetBuffers() {
    _eventBuffer.clear();
    _dataBuffer.clear();
    _retry = null;
    _hasDataField = false;
    // Note: _lastEventId is NOT reset between messages
  }

  /// Gets the last event ID (for reconnection).
  String? get lastEventId => _lastEventId;
}