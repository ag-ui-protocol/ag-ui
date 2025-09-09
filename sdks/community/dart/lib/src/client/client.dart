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
  final Map<String, CancelToken> _requestTokens = {};

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

  /// Run an agent with the given input and stream the response events
  Stream<BaseEvent> runAgent(
    String endpoint,
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    // Validate inputs
    Validators.validateUrl(config.baseUrl, 'baseUrl');
    Validators.requireNonEmpty(endpoint, 'endpoint');
    
    final fullEndpoint = endpoint.startsWith('http') 
        ? endpoint 
        : '${config.baseUrl}/$endpoint';
    
    return _runAgentInternal(fullEndpoint, input, cancelToken: cancelToken);
  }

  /// Run the agentic chat agent
  Stream<BaseEvent> runAgenticChat(
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    return runAgent('agentic_chat', input, cancelToken: cancelToken);
  }

  /// Run the human-in-the-loop agent
  Stream<BaseEvent> runHumanInTheLoop(
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    return runAgent('human_in_the_loop', input, cancelToken: cancelToken);
  }

  /// Run the agentic generative UI agent
  Stream<BaseEvent> runAgenticGenerativeUi(
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    return runAgent('agentic_generative_ui', input, cancelToken: cancelToken);
  }

  /// Run the tool-based generative UI agent
  Stream<BaseEvent> runToolBasedGenerativeUi(
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    return runAgent('tool_based_generative_ui', input, cancelToken: cancelToken);
  }

  /// Run the shared state agent
  Stream<BaseEvent> runSharedState(
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    return runAgent('shared_state', input, cancelToken: cancelToken);
  }

  /// Run the predictive state updates agent
  Stream<BaseEvent> runPredictiveStateUpdates(
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    return runAgent('predictive_state_updates', input, cancelToken: cancelToken);
  }

  /// Internal implementation for running an agent
  Stream<BaseEvent> _runAgentInternal(
    String endpoint,
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) async* {
    final runId = input.runId ?? _generateRunId();
    cancelToken ??= CancelToken();
    _requestTokens[runId] = cancelToken;

    try {
      // Validate input
      _validateRunAgentInput(input);

      // Send POST request with RunAgentInput
      final headers = _buildHeaders();
      headers['Content-Type'] = 'application/json';
      headers['Accept'] = 'text/event-stream';

      final uri = Uri.parse(endpoint);
      final request = http.Request('POST', uri)
        ..headers.addAll(headers)
        ..body = json.encode(_encoder.encodeRunAgentInput(input));

      // Send with timeout and cancellation support
      final streamedResponse = await _sendWithCancellation(
        request,
        cancelToken,
        config.requestTimeout,
      );

      // Validate response status
      if (streamedResponse.statusCode >= 400) {
        final body = await streamedResponse.stream.bytesToString();
        throw TransportError(
          'Agent request failed',
          endpoint: endpoint,
          statusCode: streamedResponse.statusCode,
          responseBody: _truncateBody(body),
        );
      }

      // Create SSE client from response stream
      final sseClient = SseClient(
        idleTimeout: config.connectionTimeout,
        backoffStrategy: config.backoffStrategy,
      );
      _activeStreams[runId] = sseClient;

      // Parse SSE from response stream
      final sseStream = sseClient.parseStream(
        streamedResponse.stream,
        headers: streamedResponse.headers,
      );

      // Transform to AG-UI events
      yield* _transformSseStream(sseStream, runId);
    } on AgUiError {
      rethrow;
    } catch (e) {
      if (cancelToken.isCancelled) {
        throw CancellationError('Request was cancelled', operation: endpoint);
      }
      if (e is TimeoutException) {
        throw TimeoutError(
          'Agent request timed out',
          timeout: config.requestTimeout,
          operation: endpoint,
        );
      }
      throw TransportError(
        'Failed to run agent',
        endpoint: endpoint,
        cause: e,
      );
    } finally {
      _requestTokens.remove(runId);
      await _closeStream(runId);
    }
  }

  /// Send request with cancellation support
  Future<http.StreamedResponse> _sendWithCancellation(
    http.Request request,
    CancelToken cancelToken,
    Duration timeout,
  ) async {
    // Create completer for cancellation
    final completer = Completer<http.StreamedResponse>();
    
    // Start the request
    final future = _httpClient.send(request).timeout(timeout);
    
    // Listen for cancellation
    cancelToken.onCancel.then((_) {
      if (!completer.isCompleted) {
        completer.completeError(
          CancellationError('Request cancelled', operation: request.url.toString()),
        );
      }
    });
    
    // Complete with result or error
    future.then(
      (response) {
        if (!completer.isCompleted) {
          completer.complete(response);
        }
      },
      onError: (Object error) {
        if (!completer.isCompleted) {
          completer.completeError(error);
        }
      },
    );
    
    return completer.future;
  }

  /// Cancel an active agent run
  Future<void> cancelRun(String runId) async {
    // Cancel the request token if it exists
    final token = _requestTokens[runId];
    if (token != null && !token.isCancelled) {
      token.cancel();
    }
    
    // Close any active stream
    await _closeStream(runId);
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
            responseBody: _truncateBody(response.body),
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

  /// Validate RunAgentInput
  void _validateRunAgentInput(SimpleRunAgentInput input) {
    // Validate thread ID if present
    if (input.threadId != null) {
      Validators.requireNonEmpty(input.threadId!, 'threadId');
    }
    
    // Validate messages if present
    if (input.messages != null) {
      for (final message in input.messages!) {
        if (message is UserMessage) {
          Validators.validateMessageContent(message.content);
        }
      }
    }
  }

  /// Generate a unique run ID
  String _generateRunId() {
    final timestamp = DateTime.now().millisecondsSinceEpoch;
    final random = DateTime.now().microsecond;
    return 'run_${timestamp}_$random';
  }

  /// Truncate response body for error messages
  String _truncateBody(String body, {int maxLength = 500}) {
    if (body.length <= maxLength) return body;
    return '${body.substring(0, maxLength)}...';
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
    // Cancel all active requests
    for (final token in _requestTokens.values) {
      token.cancel();
    }
    _requestTokens.clear();
    
    // Close all active streams
    final closeOps = _activeStreams.values.map((c) => c.close());
    await Future.wait(closeOps);
    _activeStreams.clear();
    
    // Close HTTP client
    _httpClient.close();
  }
}

/// Cancel token for request cancellation
class CancelToken {
  final _completer = Completer<void>();
  bool _isCancelled = false;

  bool get isCancelled => _isCancelled;
  Future<void> get onCancel => _completer.future;

  void cancel() {
    if (!_isCancelled) {
      _isCancelled = true;
      if (!_completer.isCompleted) {
        _completer.complete();
      }
    }
  }
}

/// Simplified input for running an agent via HTTP endpoint
class SimpleRunAgentInput {
  final String? threadId;
  final String? runId;
  final List<Message>? messages;
  final Map<String, dynamic>? config;
  final Map<String, dynamic>? metadata;

  const SimpleRunAgentInput({
    this.threadId,
    this.runId,
    this.messages,
    this.config,
    this.metadata,
  });

  Map<String, dynamic> toJson() {
    return {
      if (threadId != null) 'thread_id': threadId,
      if (runId != null) 'run_id': runId,
      if (messages != null) 'messages': messages!.map((m) => m.toJson()).toList(),
      if (config != null) 'config': config,
      if (metadata != null) 'metadata': metadata,
    };
  }
}