/// Event decoder for AG-UI protocol.
///
/// Decodes wire format (SSE or binary) to Dart models.
library;

import 'dart:convert';
import 'dart:typed_data';

import '../client/errors.dart';
import '../client/validators.dart';
import '../events/events.dart';
import '../types/base.dart';

/// Decoder for AG-UI events.
///
/// Supports decoding events from SSE (Server-Sent Events) format
/// and binary format (protobuf or SSE as bytes).
class EventDecoder {
  /// Creates a decoder instance.
  const EventDecoder();

  /// Decodes an event from a string (assumed to be JSON).
  ///
  /// This method expects a JSON string without the SSE "data: " prefix.
  BaseEvent decode(String data) {
    try {
      final json = jsonDecode(data) as Map<String, dynamic>;
      return decodeJson(json);
    } on FormatException catch (e) {
      throw DecodingError(
        'Invalid JSON format',
        field: 'data',
        expectedType: 'JSON',
        actualValue: data,
        cause: e,
      );
    } on AgUiError {
      rethrow;
    } catch (e) {
      throw DecodingError(
        'Failed to decode event',
        field: 'event',
        expectedType: 'BaseEvent',
        actualValue: data,
        cause: e,
      );
    }
  }

  /// Decodes an event from a JSON map.
  BaseEvent decodeJson(Map<String, dynamic> json) {
    try {
      // Validate required fields
      Validators.requireNonEmpty(json['type'] as String?, 'type');
      
      final event = BaseEvent.fromJson(json);
      
      // Validate the created event
      validate(event);
      
      return event;
    } on AgUiError {
      rethrow;
    } catch (e) {
      throw DecodingError(
        'Failed to create event from JSON',
        field: 'json',
        expectedType: 'BaseEvent',
        actualValue: json,
        cause: e,
      );
    }
  }

  /// Decodes an SSE message.
  ///
  /// Expects a complete SSE message with "data: " prefix and double newlines.
  BaseEvent decodeSSE(String sseMessage) {
    // Extract data from SSE format
    final lines = sseMessage.split('\n');
    final dataLines = <String>[];
    
    for (final line in lines) {
      if (line.startsWith('data: ')) {
        dataLines.add(line.substring(6)); // Remove "data: " prefix
      } else if (line.startsWith('data:')) {
        dataLines.add(line.substring(5)); // Remove "data:" prefix
      }
    }
    
    if (dataLines.isEmpty) {
      throw DecodingError(
        'No data found in SSE message',
        field: 'sseMessage',
        expectedType: 'SSE with data field',
        actualValue: sseMessage,
      );
    }
    
    // Join all data lines (for multi-line data)
    final data = dataLines.join('\n');
    
    // Handle special SSE comment for keep-alive
    if (data.trim() == ':') {
      throw DecodingError(
        'SSE keep-alive comment, not an event',
        field: 'data',
        expectedType: 'JSON event data',
        actualValue: data,
      );
    }
    
    return decode(data);
  }

  /// Decodes an event from binary data.
  ///
  /// Currently assumes the binary data is UTF-8 encoded SSE.
  /// TODO: Add protobuf support when proto definitions are available.
  BaseEvent decodeBinary(Uint8List data) {
    try {
      final string = utf8.decode(data);
      
      // Check if it looks like SSE format
      if (string.startsWith('data:')) {
        return decodeSSE(string);
      } else {
        // Assume it's raw JSON
        return decode(string);
      }
    } on FormatException catch (e) {
      throw DecodingError(
        'Invalid UTF-8 data',
        field: 'binary',
        expectedType: 'UTF-8 encoded data',
        actualValue: data,
        cause: e,
      );
    }
  }

  /// Validates that an event has all required fields.
  ///
  /// Returns true if valid, throws [ValidationError] if not.
  bool validate(BaseEvent event) {
    // Basic validation - ensure type is set
    Validators.validateEventType(event.type);
    
    // Type-specific validation
    switch (event) {
      case TextMessageStartEvent():
        Validators.requireNonEmpty(event.messageId, 'messageId');
      case TextMessageContentEvent():
        Validators.requireNonEmpty(event.messageId, 'messageId');
        Validators.requireNonEmpty(event.delta, 'delta');
      case ThinkingContentEvent():
        Validators.requireNonEmpty(event.delta, 'delta');
      case ToolCallStartEvent():
        Validators.requireNonEmpty(event.toolCallId, 'toolCallId');
        Validators.requireNonEmpty(event.toolCallName, 'toolCallName');
      case RunStartedEvent():
        Validators.validateThreadId(event.threadId);
        Validators.validateRunId(event.runId);
      default:
        // No specific validation for other event types
        break;
    }
    
    return true;
  }
}