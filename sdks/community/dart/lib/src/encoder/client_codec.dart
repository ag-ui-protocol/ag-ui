/// Client-specific encoding and decoding extensions for AG-UI protocol.
library;

import 'dart:convert';
import '../client/client.dart';
import '../types/types.dart';

/// Encoder extensions for client operations
class Encoder {
  const Encoder();

  /// Encode StartRunRequest to JSON
  Map<String, dynamic> encodeStartRunRequest(StartRunRequest request) {
    final json = <String, dynamic>{};
    
    if (request.input != null) {
      json['input'] = request.input;
    }
    if (request.config != null) {
      json['config'] = request.config;
    }
    if (request.metadata != null) {
      json['metadata'] = request.metadata;
    }
    
    return json;
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

  /// Decode StartRunResponse from JSON
  StartRunResponse decodeStartRunResponse(Map<String, dynamic> json) {
    return StartRunResponse(
      runId: json['runId'] as String? ?? json['run_id'] as String,
      sessionId: json['sessionId'] as String? ?? json['session_id'] as String?,
      metadata: json['metadata'] as Map<String, dynamic>?,
    );
  }

  /// Decode SendMessageResponse from JSON
  SendMessageResponse decodeSendMessageResponse(Map<String, dynamic> json) {
    return SendMessageResponse(
      messageId: json['messageId'] as String? ?? json['message_id'] as String?,
      success: json['success'] as bool? ?? true,
    );
  }

  /// Decode ToolResultResponse from JSON
  ToolResultResponse decodeToolResultResponse(Map<String, dynamic> json) {
    return ToolResultResponse(
      success: json['success'] as bool? ?? true,
      message: json['message'] as String?,
    );
  }
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