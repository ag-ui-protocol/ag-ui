import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

import '../encoder/client_codec.dart' as codec;
import '../encoder/stream_adapter.dart' show EventStreamAdapter;
import '../events/events.dart';
import '../sse/sse_client.dart';
import '../sse/sse_message.dart';
import '../types/types.dart';
import 'config.dart';
import 'errors.dart';
import 'validators.dart';

/// Main client for interacting with AG-UI servers
class AgUiClient {
  final AgUiClientConfig config;
  final http.Client _httpClient;
  final codec.Encoder _encoder;
  final codec.Decoder _decoder;
  final EventStreamAdapter _streamAdapter;
  final Map<String, SseClient> _activeStreams = {};

  AgUiClient({
    required this.config,
    http.Client? httpClient,
    codec.Encoder? encoder,
    codec.Decoder? decoder,
    EventStreamAdapter? streamAdapter,
  })  : _httpClient = httpClient ?? http.Client(),
        _encoder = encoder ?? const codec.Encoder(),
        _decoder = decoder ?? const codec.Decoder(),
        _streamAdapter = streamAdapter ?? EventStreamAdapter();

  /// Start a new run/session
  Future<StartRunResponse> startRun(StartRunRequest request) async {
    // Validate input
    Validators.validateUrl(config.baseUrl, 'baseUrl');
    
    final endpoint = '${config.baseUrl}/runs';
    try {
      final response = await _sendRequest(
        'POST',
        endpoint,
        body: _encoder.encodeStartRunRequest(request),
      );
      return _handleResponse<StartRunResponse>(
        response,
        endpoint,
        (data) => _decoder.decodeStartRunResponse(data),
      );
    } on AgUiError {
      rethrow;
    } catch (e) {
      throw TransportError(
        'Failed to start run',
        endpoint: endpoint,
        cause: e,
      );
    }
  }

  /// Send a user message to an active run
  Future<SendMessageResponse> sendMessage(
    String runId,
    UserMessage message,
  ) async {
    // Validate inputs
    Validators.validateRunId(runId);
    Validators.validateMessageContent(message.content);
    
    final endpoint = '${config.baseUrl}/runs/$runId/messages';
    try {
      final response = await _sendRequest(
        'POST',
        endpoint,
        body: _encoder.encodeUserMessage(message),
      );
      return _handleResponse<SendMessageResponse>(
        response,
        endpoint,
        (data) => _decoder.decodeSendMessageResponse(data),
      );
    } on AgUiError {
      rethrow;
    } catch (e) {
      throw TransportError(
        'Failed to send message',
        endpoint: endpoint,
        cause: e,
      );
    }
  }

  /// Submit a tool result for a specific tool call
  Future<ToolResultResponse> submitToolResult(
    String runId,
    String toolCallId,
    codec.ToolResult result,
  ) async {
    // Validate inputs
    Validators.validateRunId(runId);
    Validators.requireNonEmpty(toolCallId, 'toolCallId');
    
    final endpoint = '${config.baseUrl}/runs/$runId/tools/$toolCallId/result';
    try {
      final response = await _sendRequest(
        'POST',
        endpoint,
        body: _encoder.encodeToolResult(result),
      );
      return _handleResponse<ToolResultResponse>(
        response,
        endpoint,
        (data) => _decoder.decodeToolResultResponse(data),
      );
    } on AgUiError {
      rethrow;
    } catch (e) {
      throw TransportError(
        'Failed to submit tool result',
        endpoint: endpoint,
        cause: e,
      );
    }
  }

  /// Cancel an active run
  Future<void> cancelRun(String runId) async {
    // Validate input
    Validators.validateRunId(runId);
    
    final endpoint = '${config.baseUrl}/runs/$runId/cancel';
    try {
      final response = await _sendRequest('POST', endpoint);
      if (response.statusCode != 200 && response.statusCode != 204) {
        throw TransportError(
          'Failed to cancel run',
          endpoint: endpoint,
          statusCode: response.statusCode,
          responseBody: response.body,
        );
      }
      // Also cancel any active stream for this run
      await _closeStream(runId);
    } on AgUiError {
      rethrow;
    } catch (e) {
      throw TransportError(
        'Failed to cancel run',
        endpoint: endpoint,
        cause: e,
      );
    }
  }

  /// Stream events for a run
  Stream<BaseEvent> streamEvents(String runId) {
    // Validate input
    Validators.validateRunId(runId);
    
    final endpoint = '${config.baseUrl}/runs/$runId/events';
    final uri = Uri.parse(endpoint);
    
    // Create SSE client for this run
    final sseClient = SseClient(
      idleTimeout: config.connectionTimeout,
      backoffStrategy: config.backoffStrategy,
    );
    
    // Store the client for cleanup
    _activeStreams[runId] = sseClient;
    
    // Connect and transform the stream
    final sseStream = sseClient.connect(
      uri,
      headers: _buildHeaders(),
      requestTimeout: config.requestTimeout,
    );
    
    // Transform SSE messages to AG-UI events
    return _transformSseStream(sseStream, runId);
  }

  /// Transform SSE messages to typed AG-UI events
  Stream<BaseEvent> _transformSseStream(
    Stream<SseMessage> sseStream,
    String runId,
  ) async* {
    try {
      await for (final message in sseStream) {
        if (message.data == null || message.data!.isEmpty) {
          continue;
        }

        try {
          // Parse the SSE data as JSON
          final jsonData = json.decode(message.data!);
          
          // Use the stream adapter to convert to typed events
          final events = _streamAdapter.adaptJsonToEvents(jsonData);
          
          for (final event in events) {
            yield event;
          }
        } on AgUiError catch (e) {
          // Re-throw AG-UI errors to the stream
          yield* Stream.error(e);
        } catch (e) {
          // Wrap other errors
          yield* Stream.error(DecodingError(
            'Failed to decode SSE message',
            field: 'message.data',
            expectedType: 'BaseEvent',
            actualValue: message.data,
            cause: e,
          ));
        }
      }
    } finally {
      // Clean up when stream ends
      await _closeStream(runId);
    }
  }

  /// Send an HTTP request with retries
  Future<http.Response> _sendRequest(
    String method,
    String endpoint, {
    Map<String, dynamic>? body,
  }) async {
    final headers = _buildHeaders();
    if (body != null) {
      headers['Content-Type'] = 'application/json';
    }

    int attempts = 0;
    Duration? nextDelay;

    while (attempts <= config.maxRetries) {
      try {
        // Add delay for retries
        if (nextDelay != null) {
          await Future.delayed(nextDelay);
        }

        final uri = Uri.parse(endpoint);
        final request = http.Request(method, uri)
          ..headers.addAll(headers);

        if (body != null) {
          request.body = json.encode(body);
        }

        final streamedResponse = await _httpClient
            .send(request)
            .timeout(config.requestTimeout);
        
        final response = await http.Response.fromStream(streamedResponse);

        // Success or client error (don't retry)
        if (response.statusCode < 500) {
          return response;
        }

        // Server error - retry
        attempts++;
        if (attempts <= config.maxRetries) {
          nextDelay = config.backoffStrategy.nextDelay(attempts);
        } else {
          throw TransportError(
            'Request failed after ${config.maxRetries} retries',
            endpoint: endpoint,
            statusCode: response.statusCode,
            responseBody: response.body,
          );
        }
      } on TimeoutException {
        attempts++;
        if (attempts > config.maxRetries) {
          throw TimeoutError(
            'Request timed out after ${config.maxRetries} attempts',
            timeout: config.requestTimeout,
            operation: '$method $endpoint',
          );
        }
        nextDelay = config.backoffStrategy.nextDelay(attempts);
      } catch (e) {
        if (e is AgUiError) rethrow;
        
        attempts++;
        if (attempts > config.maxRetries) {
          throw TransportError(
            'Connection failed after ${config.maxRetries} attempts',
            endpoint: endpoint,
            cause: e,
          );
        }
        nextDelay = config.backoffStrategy.nextDelay(attempts);
      }
    }

    throw TransportError(
      'Unexpected error in request retry logic',
      endpoint: endpoint,
    );
  }

  /// Handle HTTP response and decode
  T _handleResponse<T>(
    http.Response response,
    String endpoint,
    T Function(Map<String, dynamic>) decoder,
  ) {
    // Validate status code
    Validators.validateStatusCode(response.statusCode, endpoint, response.body);
    
    try {
      final data = Validators.validateJson(
        json.decode(response.body),
        'response',
      );
      return decoder(data);
    } on AgUiError {
      rethrow;
    } catch (e) {
      throw DecodingError(
        'Failed to decode response',
        field: 'response.body',
        expectedType: 'JSON object',
        actualValue: response.body,
        cause: e,
      );
    }
  }

  /// Build headers for requests
  Map<String, String> _buildHeaders() {
    return {
      ...config.defaultHeaders,
      'Accept': 'application/json, text/event-stream',
    };
  }

  /// Close a specific stream
  Future<void> _closeStream(String runId) async {
    final client = _activeStreams.remove(runId);
    await client?.close();
  }

  /// Close all resources
  Future<void> close() async {
    // Close all active streams
    final closeOps = _activeStreams.values.map((c) => c.close());
    await Future.wait(closeOps);
    _activeStreams.clear();
    
    // Close HTTP client
    _httpClient.close();
  }
}

/// Request/Response types for client operations
class StartRunRequest {
  final Map<String, dynamic>? input;
  final Map<String, dynamic>? config;
  final Map<String, dynamic>? metadata;

  const StartRunRequest({
    this.input,
    this.config,
    this.metadata,
  });
}

class StartRunResponse {
  final String runId;
  final String? sessionId;
  final Map<String, dynamic>? metadata;

  const StartRunResponse({
    required this.runId,
    this.sessionId,
    this.metadata,
  });
}

class SendMessageResponse {
  final String? messageId;
  final bool success;

  const SendMessageResponse({
    this.messageId,
    this.success = true,
  });
}

class ToolResultResponse {
  final bool success;
  final String? message;

  const ToolResultResponse({
    this.success = true,
    this.message,
  });
}