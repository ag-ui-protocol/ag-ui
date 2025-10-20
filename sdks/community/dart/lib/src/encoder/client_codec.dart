/// Client-specific encoding and decoding extensions for AG-UI protocol.
library;

import 'dart:convert';
import '../client/client.dart' show SimpleRunAgentInput;
import '../types/types.dart';

/// Encoder extensions for client operations
class Encoder {
  const Encoder();

  /// Encode RunAgentInput to JSON
  Map<String, dynamic> encodeRunAgentInput(SimpleRunAgentInput input) {
    return input.toJson();
  }

  /// Encode UserMessage to JSON
  Map<String, dynamic> encodeUserMessage(UserMessage message) {
    return message.toJson();
  }

  /// Encode ToolResult to JSON
  Map<String, dynamic> encodeToolResult(ToolResult result) {
    return {
      'toolCallId': result.toolCallId,
      'result': result.result,
      if (result.error != null) 'error': result.error,
      if (result.metadata != null) 'metadata': result.metadata,
    };
  }
}

/// Decoder extensions for client operations
class Decoder {
  const Decoder();
}

/// ToolResult model for submitting tool execution results
class ToolResult {
  final String toolCallId;
  final dynamic result;
  final String? error;
  final Map<String, dynamic>? metadata;

  const ToolResult({
    required this.toolCallId,
    required this.result,
    this.error,
    this.metadata,
  });
}