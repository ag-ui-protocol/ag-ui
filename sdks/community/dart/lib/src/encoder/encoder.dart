/// Event encoder for AG-UI protocol.
///
/// Encodes Dart models to wire format (SSE or binary).
library;

import 'dart:convert';
import 'dart:typed_data';

import '../events/events.dart';

/// The AG-UI protobuf media type constant.
const String aguiMediaType = 'application/vnd.ag-ui.event+proto';

/// Encoder for AG-UI events.
///
/// Supports encoding events to SSE (Server-Sent Events) format
/// and binary format (protobuf or SSE as bytes).
class EventEncoder {
  /// Whether this encoder accepts protobuf format.
  final bool acceptsProtobuf;

  /// Creates an encoder with optional format preferences.
  ///
  /// [accept] - Optional Accept header value to determine format preferences.
  EventEncoder({String? accept})
      : acceptsProtobuf = accept != null && _isProtobufAccepted(accept);

  /// Gets the content type for this encoder.
  String getContentType() {
    if (acceptsProtobuf) {
      return aguiMediaType;
    } else {
      return 'text/event-stream';
    }
  }

  /// Encodes an event to string format (SSE).
  String encode(BaseEvent event) {
    return encodeSSE(event);
  }

  /// Encodes an event to SSE format.
  ///
  /// The SSE format is:
  /// ```
  /// data: {"type":"...", ...}
  ///
  /// ```
  String encodeSSE(BaseEvent event) {
    final json = event.toJson();
    // Remove null values for cleaner output
    json.removeWhere((key, value) => value == null);
    final jsonString = jsonEncode(json);
    return 'data: $jsonString\n\n';
  }

  /// Encodes an event to binary format.
  ///
  /// If protobuf is accepted, uses protobuf encoding (not yet implemented).
  /// Otherwise, converts SSE string to bytes.
  Uint8List encodeBinary(BaseEvent event) {
    if (acceptsProtobuf) {
      // TODO: Implement protobuf encoding when proto definitions are available
      // For now, fall back to SSE as bytes
      return _encodeSSEAsBytes(event);
    } else {
      return _encodeSSEAsBytes(event);
    }
  }

  /// Encodes an SSE event as bytes.
  Uint8List _encodeSSEAsBytes(BaseEvent event) {
    final sseString = encodeSSE(event);
    return Uint8List.fromList(utf8.encode(sseString));
  }

  /// Checks if protobuf format is accepted based on Accept header.
  static bool _isProtobufAccepted(String acceptHeader) {
    // Simple check for protobuf media type
    // In production, this should use proper media type negotiation
    return acceptHeader.contains(aguiMediaType);
  }
}