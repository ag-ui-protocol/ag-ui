import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:typed_data';

import '../internal/sse_constants.dart';
import 'sse_message.dart';

/// Parses Server-Sent Events according to the WHATWG specification.
///
/// `SseParser` instances are intended to be **per-connection**. The
/// `_eventBuffer`, `_dataBuffer`, `_retry`, and `_hasDataField` fields
/// are reset between events via [_resetBuffers], but `_lastEventId` is
/// intentionally sticky across messages on the same connection (per the
/// SSE spec: the last `id:` field is preserved so a reconnecting client
/// can supply it via the `Last-Event-ID` request header).
///
/// If you reuse a single `SseParser` instance across multiple
/// independent streams (e.g. in tests), `_lastEventId` carries across —
/// which is consistent with the spec's reconnection semantics but can
/// be surprising in test harnesses. Construct a fresh parser per stream
/// when you want clean isolation, or call [reset] to clear all parser
/// state including `_lastEventId`. The streaming-side counterpart in
/// `EventStreamAdapter.fromRawSseStream` keeps its parsing state in
/// per-invocation locals and does not have this concern.
class SseParser {
  /// Maximum number of UTF-16 code units the `_dataBuffer` may accumulate
  /// before a message is dispatched. Prevents a malicious or misbehaving SSE
  /// producer from growing the buffer without bound across `data:` lines,
  /// causing an OOM before the terminating blank line arrives.
  ///
  /// **Note:** The cap is measured in UTF-16 code units (Dart's internal string
  /// unit), not UTF-8 bytes. ASCII content has a 1:1 ratio; BMP characters
  /// outside ASCII still count as one code unit; supplementary characters
  /// (emoji, etc.) count as two. For most JSON payloads the difference is
  /// negligible, but the name reflects what is actually measured.
  ///
  /// Default: 8 MiB (8 × 1024 × 1024 code units). Adjust via the
  /// [SseParser.new] constructor when your use-case legitimately requires
  /// larger payloads.
  final int maxDataCodeUnits;

  /// Maximum number of UTF-16 code units in one decoded SSE line.
  ///
  /// Raw byte parsing enforces this limit before a line terminator arrives.
  /// [parseLines] also rejects complete input lines over the limit. It defaults
  /// to [maxDataCodeUnits] plus the seven code units in the longest supported
  /// field prefix, `event: `.
  final int maxLineCodeUnits;

  /// Maximum number of UTF-16 code units the `id:` field value may contain.
  /// Caps the sticky `_lastEventId` value to prevent a malicious server from
  /// growing the stored id across reconnects via an oversized `id:` line.
  static const int maxIdCodeUnits = 1024;

  // `_eventBuffer` stores the SSE `event:` field for the current message.
  // Unlike `_dataBuffer`, it is replaced rather than appended across lines.
  final _eventBuffer = StringBuffer();
  final _dataBuffer = StringBuffer();
  String? _lastEventId;
  Duration? _retry;
  bool _hasDataField = false;

  SseParser({
    int maxDataCodeUnits = kSseDefaultMaxDataCodeUnits,
    int? maxLineCodeUnits,
  })  : maxDataCodeUnits = _validateDataLimit(maxDataCodeUnits),
        maxLineCodeUnits =
            _resolveLineLimit(maxDataCodeUnits, maxLineCodeUnits);

  /// Clears all parser state, including the otherwise-sticky
  /// `_lastEventId`. Use when reusing a parser instance across
  /// independent streams that should not share reconnection state.
  void reset() {
    _resetBuffers();
    _lastEventId = null;
  }

  /// Parses SSE data and yields messages.
  ///
  /// The input should be a stream of text lines from an SSE endpoint.
  /// Empty lines trigger message dispatch.
  Stream<SseMessage> parseLines(Stream<String> lines) async* {
    try {
      await for (final line in lines) {
        if (line.length > maxLineCodeUnits) {
          throw _lineOverflow(maxLineCodeUnits);
        }
        final message = _processLine(line);
        if (message != null) {
          yield message;
        }
      }

      final finalMessage = _dispatchEvent();
      if (finalMessage != null) {
        yield finalMessage;
      }
    } finally {
      _resetBuffers();
    }
  }

  /// Parses raw bytes from an SSE stream.
  ///
  /// Rejects an oversized unfinished line before its terminator or EOF.
  Stream<SseMessage> parseBytes(Stream<List<int>> bytes) =>
      _SseByteSession(this, bytes).stream;

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
        // Per WHATWG: "If the field name is 'event', set the event type
        // buffer to field value." The buffer is REPLACED on each `event:`
        // line, not appended to. The previous `_eventBuffer.write(value)`
        // concatenated repeated `event:` lines within a single dispatch
        // block — spec-non-compliant and divergent from the canonical
        // SDKs.
        // Defense-in-depth cap: a single oversized `event:` line cannot
        // allocate unbounded memory before the dispatch blank line arrives.
        // The cap mirrors the `data:` path in the same method.
        if (value.length > maxDataCodeUnits) {
          _resetBuffers();
          throw FormatException(
            'SSE event field exceeds $maxDataCodeUnits-code-unit limit '
            '(${value.length} code units)',
          );
        }
        _eventBuffer
          ..clear()
          ..write(value);
        break;
      case 'data':
        // Per WHATWG: every `data:` field appends `\n` BEFORE its value
        // (the trailing `\n` is then stripped at dispatch). The previous
        // `_dataBuffer.isNotEmpty` heuristic skipped the leading `\n`
        // when the first `data:` line was empty, collapsing
        // `data:\ndata: x` to `"x"` instead of the spec-correct `"\nx"`.
        // Use `_hasDataField` to track "have we already received a
        // `data:` field in this block?" — which is the actual
        // spec-mandated condition. Mirrors the `inDataBlock` flag pattern
        // in `EventStreamAdapter.appendDataLine`.
        // Guard against unbounded growth from a malicious/misbehaving
        // producer. Reject the entire message if the accumulated data
        // would exceed [maxDataCodeUnits], reset buffers, and throw so the
        // caller's stream adapter can surface a structured error instead
        // of quietly OOM-ing.
        final newlineBytes =
            _hasDataField ? 1 : 0; // \n separator between lines
        if (value.length >
            maxDataCodeUnits - _dataBuffer.length - newlineBytes) {
          _resetBuffers();
          throw FormatException(
            'SSE data field exceeds $maxDataCodeUnits-code-unit limit '
            '(current ${_dataBuffer.length} + incoming '
            '${newlineBytes + value.length} code units)',
          );
        }
        if (_hasDataField) {
          _dataBuffer.write('\n'); // explicit \n, not platform line terminator
        }
        _hasDataField = true;
        _dataBuffer.write(value);
        break;
      case 'id':
        // Per WHATWG SSE spec: id values must not contain \n, \r, or \x00
        // (NUL). NUL-bearing ids are silently ignored and the prior
        // `_lastEventId` survives unchanged. Cap at ≤1024 UTF-16 code units
        // (~1–4 KB on the wire depending on encoding) to prevent a malicious
        // server from growing the stored value across reconnects via an
        // oversized `id:` line (the value persists for the lifetime of the
        // connection and propagates via `Last-Event-ID` headers).
        if (value.contains('\n') ||
            value.contains('\r') ||
            value.contains('\x00')) {
          // Spec-mandated silent drop — no log needed.
          break;
        }
        if (value.length > maxIdCodeUnits) {
          // Defense-in-depth cap (non-spec). Log so operators can detect
          // misbehaving SSE producers. `_lastEventId` is NOT updated; the
          // prior value is preserved (used as Last-Event-ID on reconnect).
          developer.log(
            'SSE id field dropped: length ${value.length} exceeds '
            'maxIdCodeUnits ($maxIdCodeUnits). _lastEventId not updated.',
            name: 'ag_ui.sse_parser',
          );
          break;
        }
        _lastEventId = value;
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

const int _largestExactInteger = 9007199254740991;
const int _decoderSliceBytes = 1024;

int _validateDataLimit(int limit) {
  if (limit <= 0 || limit > _largestExactInteger) {
    throw ArgumentError.value(
      limit,
      'maxDataCodeUnits',
      'must be a positive exactly representable integer',
    );
  }
  return limit;
}

int _resolveLineLimit(int dataLimit, int? lineLimit) {
  _validateDataLimit(dataLimit);
  if (lineLimit == null && dataLimit > _largestExactInteger - 7) {
    throw ArgumentError.value(
      dataLimit,
      'maxDataCodeUnits',
      'derived line limit is not exactly representable',
    );
  }
  final resolved = lineLimit ?? dataLimit + 7;
  if (resolved <= 0 || resolved > _largestExactInteger) {
    throw ArgumentError.value(
      lineLimit,
      'maxLineCodeUnits',
      'must be a positive exactly representable integer',
    );
  }
  return resolved;
}

FormatException _lineOverflow(int limit) =>
    FormatException('SSE line exceeds $limit-code-unit limit');

enum _SseByteState { active, finishing, failed, cancelled, closed }

final class _SseByteSession {
  _SseByteSession(this._parser, this._source) {
    _decoder = utf8.decoder.startChunkedConversion(
      StringConversionSink.fromStringSink(_decodedOutput),
    );
    _output = StreamController<SseMessage>(
      sync: true,
      onListen: _listen,
      onPause: _pause,
      onResume: _resume,
      onCancel: _cancel,
    );
  }

  final SseParser _parser;
  final Stream<List<int>> _source;
  final StringBuffer _decodedOutput = StringBuffer();
  late final StreamController<SseMessage> _output;
  late ByteConversionSink? _decoder;
  StreamSubscription<List<int>>? _subscription;
  Future<void>? _sourceCancellation;
  _SseByteState _state = _SseByteState.active;

  List<int>? _inputChunk;
  int _inputOffset = 0;
  String? _decodedSlice;
  int _decodedOffset = 0;
  Object? _pendingDecodeError;
  StackTrace? _pendingDecodeStackTrace;
  Uint16List _line = Uint16List(0);
  int _lineLength = 0;
  bool _skipLf = false;
  bool _atTextStart = true;
  bool _sourcePaused = false;
  bool _pumpScheduled = false;
  bool _pumping = false;

  Stream<SseMessage> get stream => _output.stream;

  void _listen() {
    _subscription = _source.listen(
      _acceptChunk,
      onError: _sourceError,
      onDone: _sourceDone,
      cancelOnError: false,
    );
  }

  void _acceptChunk(List<int> chunk) {
    if (_state != _SseByteState.active || chunk.isEmpty) {
      return;
    }
    _subscription?.pause();
    _sourcePaused = true;
    _inputChunk = chunk;
    _inputOffset = 0;
    _schedulePump();
  }

  void _sourceError(Object error, StackTrace stackTrace) {
    _fail(error, stackTrace);
  }

  void _sourceDone() {
    if (_state != _SseByteState.active) {
      return;
    }
    _state = _SseByteState.finishing;
    try {
      _decoder!.close();
      _decoder = null;
      _takeDecodedOutput();
    } on FormatException catch (_, stackTrace) {
      _decoder = null;
      _pendingDecodeError = const FormatException('Invalid SSE UTF-8');
      _pendingDecodeStackTrace = stackTrace;
      _takeDecodedOutput();
    }
    _schedulePump();
  }

  void _schedulePump() {
    if (_pumpScheduled ||
        _state == _SseByteState.failed ||
        _state == _SseByteState.cancelled ||
        _state == _SseByteState.closed) {
      return;
    }
    _pumpScheduled = true;
    scheduleMicrotask(() {
      _pumpScheduled = false;
      _pump();
    });
  }

  void _pump() {
    if (_pumping ||
        _output.isPaused ||
        (_state != _SseByteState.active && _state != _SseByteState.finishing)) {
      return;
    }
    _pumping = true;
    try {
      while (!_output.isPaused &&
          (_state == _SseByteState.active ||
              _state == _SseByteState.finishing)) {
        final decoded = _decodedSlice;
        if (decoded != null && _decodedOffset < decoded.length) {
          final codeUnit = decoded.codeUnitAt(_decodedOffset++);
          final message = _acceptCodeUnit(codeUnit);
          if (message != null) {
            _schedulePump();
            _output.add(message);
            return;
          }
          continue;
        }

        _decodedSlice = null;
        _decodedOffset = 0;

        final decodeError = _pendingDecodeError;
        if (decodeError != null) {
          final decodeStackTrace = _pendingDecodeStackTrace!;
          _pendingDecodeError = null;
          _pendingDecodeStackTrace = null;
          _fail(decodeError, decodeStackTrace);
          return;
        }

        final input = _inputChunk;
        if (input != null && _inputOffset < input.length) {
          var end = _inputOffset;
          while (
              end < input.length && end - _inputOffset < _decoderSliceBytes) {
            final byte = input[end++];
            if (byte == 0x0D || byte == 0x0A) {
              break;
            }
          }
          try {
            _decoder!.addSlice(input, _inputOffset, end, false);
          } on FormatException catch (_, stackTrace) {
            _inputChunk = null;
            _inputOffset = 0;
            _decoder = null;
            _pendingDecodeError = const FormatException('Invalid SSE UTF-8');
            _pendingDecodeStackTrace = stackTrace;
            _takeDecodedOutput();
            continue;
          }
          _inputOffset = end;
          _takeDecodedOutput();
          continue;
        }

        _inputChunk = null;
        _inputOffset = 0;

        if (_state == _SseByteState.finishing) {
          if (_lineLength != 0) {
            _parser._processLine(_takeLine());
          }
          final message = _parser._dispatchEvent();
          _state = _SseByteState.closed;
          _releaseTransientState();
          if (message != null) {
            _output.add(message);
          }
          unawaited(_output.close());
          return;
        }

        _resumeSourceIfReady();
        return;
      }
    } on Object catch (error, stackTrace) {
      _fail(error, stackTrace);
    } finally {
      _pumping = false;
    }
  }

  void _takeDecodedOutput() {
    final decoded = _decodedOutput.toString();
    _decodedOutput.clear();
    if (decoded.isNotEmpty) {
      _decodedSlice = decoded;
      _decodedOffset = 0;
    }
  }

  SseMessage? _acceptCodeUnit(int codeUnit) {
    if (_atTextStart) {
      _atTextStart = false;
      if (codeUnit == 0xFEFF) {
        return null;
      }
    }
    if (_skipLf) {
      _skipLf = false;
      if (codeUnit == 0x0A) {
        return null;
      }
    }
    if (codeUnit == 0x0D || codeUnit == 0x0A) {
      _skipLf = codeUnit == 0x0D;
      return _parser._processLine(_takeLine());
    }
    _appendCodeUnit(codeUnit);
    return null;
  }

  void _appendCodeUnit(int codeUnit) {
    if (_lineLength == _parser.maxLineCodeUnits) {
      throw _lineOverflow(_parser.maxLineCodeUnits);
    }
    if (_lineLength == _line.length) {
      final remaining = _parser.maxLineCodeUnits - _lineLength;
      final growth = _line.isEmpty
          ? (_decoderSliceBytes < remaining ? _decoderSliceBytes : remaining)
          : (_lineLength < remaining ? _lineLength : remaining);
      final capacity = _lineLength + growth;
      final grown = Uint16List(capacity)..setRange(0, _lineLength, _line);
      _line = grown;
    }
    _line[_lineLength++] = codeUnit;
  }

  String _takeLine() {
    final value = String.fromCharCodes(_line, 0, _lineLength);
    _lineLength = 0;
    return value;
  }

  void _pause() {
    if ((_state == _SseByteState.active || _state == _SseByteState.finishing) &&
        !_sourcePaused) {
      _subscription?.pause();
      _sourcePaused = true;
    }
  }

  void _resume() {
    if (_state == _SseByteState.finishing ||
        _inputChunk != null ||
        _decodedSlice != null) {
      _schedulePump();
    } else {
      _resumeSourceIfReady();
    }
  }

  void _resumeSourceIfReady() {
    if (_state != _SseByteState.active || _output.isPaused || !_sourcePaused) {
      return;
    }
    _sourcePaused = false;
    _subscription?.resume();
  }

  void _fail(Object error, StackTrace stackTrace) {
    if (_state == _SseByteState.failed ||
        _state == _SseByteState.cancelled ||
        _state == _SseByteState.closed) {
      return;
    }
    _state = _SseByteState.failed;
    _releaseTransientState();
    _parser._resetBuffers();
    unawaited(_cancelSource(suppressErrors: true));
    _output.addError(error, stackTrace);
    unawaited(_output.close());
  }

  Future<void> _cancelSource({required bool suppressErrors}) {
    final existing = _sourceCancellation;
    if (existing != null) {
      return existing;
    }
    final completer = Completer<void>();
    _sourceCancellation = completer.future;
    Future<void> cancellation;
    try {
      cancellation = _subscription?.cancel() ?? Future<void>.value();
    } on Object catch (error, stackTrace) {
      cancellation = Future<void>.error(error, stackTrace);
    }
    cancellation.then<void>(
      (_) => completer.complete(),
      onError: (Object error, StackTrace stackTrace) {
        if (suppressErrors) {
          completer.complete();
        } else {
          completer.completeError(error, stackTrace);
        }
      },
    );
    return completer.future;
  }

  Future<void> _cancel() {
    if (_state == _SseByteState.closed) {
      return Future<void>.value();
    }
    if (_state == _SseByteState.failed) {
      return _sourceCancellation ?? Future<void>.value();
    }
    _state = _SseByteState.cancelled;
    _releaseTransientState();
    _parser._resetBuffers();
    return _cancelSource(suppressErrors: false);
  }

  void _releaseTransientState() {
    _inputChunk = null;
    _inputOffset = 0;
    _decodedSlice = null;
    _decodedOffset = 0;
    _pendingDecodeError = null;
    _pendingDecodeStackTrace = null;
    _decodedOutput.clear();
    _decoder = null;
    _line = Uint16List(0);
    _lineLength = 0;
  }
}
