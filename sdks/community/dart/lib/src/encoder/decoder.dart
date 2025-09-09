/// Event decoder for AG-UI protocol.
///
/// Decodes wire format (SSE or binary) to Dart models.
library;

import 'dart:convert';
import 'dart:typed_data';

import '../events/events.dart';
import '../types/base.dart';
import 'errors.dart';

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
      throw DecodeError(
        message: 'Invalid JSON format',
        source: data,
        cause: e,
      );
    } on AGUIError {
      rethrow;
    } catch (e) {
      throw DecodeError(
        message: 'Failed to decode event',
        source: data,
        cause: e,
      );
    }
  }

  /// Decodes an event from a JSON map.
  BaseEvent decodeJson(Map<String, dynamic> json) {
    try {
      return BaseEvent.fromJson(json);
    } on AGUIError {
      rethrow;
    } catch (e) {
      throw DecodeError(
        message: 'Failed to create event from JSON',
        source: json,
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
      throw DecodeError(
        message: 'No data found in SSE message',
        source: sseMessage,
      );
    }
    
    // Join all data lines (for multi-line data)
    final data = dataLines.join('\n');
    
    // Handle special SSE comment for keep-alive
    if (data.trim() == ':') {
      throw DecodeError(
        message: 'SSE keep-alive comment, not an event',
        source: sseMessage,
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
      throw DecodeError(
        message: 'Invalid UTF-8 data',
        source: data,
        cause: e,
      );
    }
  }

  /// Validates that an event has all required fields.
  ///
  /// Returns true if valid, throws [ValidationError] if not.
  bool validate(BaseEvent event) {
    // Basic validation - ensure type is set
    if (event.type.isEmpty) {
      throw ValidationError(
        message: 'Event type cannot be empty',
        field: 'type',
        value: event.type,
      );
    }
    
    // Type-specific validation
    switch (event) {
      case TextMessageStartEvent():
        if (event.messageId.isEmpty) {
          throw ValidationError(
            message: 'Message ID cannot be empty',
            field: 'messageId',
            value: event.messageId,
          );
        }
      case TextMessageContentEvent():
        if (event.messageId.isEmpty) {
          throw ValidationError(
            message: 'Message ID cannot be empty',
            field: 'messageId',
            value: event.messageId,
          );
        }
        if (event.delta.isEmpty) {
          throw ValidationError(
            message: 'Delta cannot be empty',
            field: 'delta',
            value: event.delta,
          );
        }
      case ToolCallStartEvent():
        if (event.toolCallId.isEmpty) {
          throw ValidationError(
            message: 'Tool call ID cannot be empty',
            field: 'toolCallId',
            value: event.toolCallId,
          );
        }
        if (event.toolCallName.isEmpty) {
          throw ValidationError(
            message: 'Tool call name cannot be empty',
            field: 'toolCallName',
            value: event.toolCallName,
          );
        }
      case RunStartedEvent():
        if (event.threadId.isEmpty) {
          throw ValidationError(
            message: 'Thread ID cannot be empty',
            field: 'threadId',
            value: event.threadId,
          );
        }
        if (event.runId.isEmpty) {
          throw ValidationError(
            message: 'Run ID cannot be empty',
            field: 'runId',
            value: event.runId,
          );
        }
      default:
        // No specific validation for other event types
        break;
    }
    
    return true;
  }
}