import 'dart:async';

import 'package:http/http.dart' as http;

import 'backoff_strategy.dart';
import 'sse_message.dart';
import 'sse_parser.dart';

/// A client for Server-Sent Events (SSE) with automatic reconnection.
class SseClient {
  final http.Client _httpClient;
  final Duration _idleTimeout;
  final BackoffStrategy _backoffStrategy;

  /// Maximum number of UTF-16 code units allowed in a single SSE data block.
  ///
  /// Passed to [SseParser] so the parse-layer cap matches the adapter-layer
  /// cap set on `EventStreamAdapter`. Defaults to 8 MiB (8 × 1024 × 1024
  /// code units), matching [SseParser]'s own default.
  final int maxDataCodeUnits;

  /// Maximum decoded SSE line length in UTF-16 code units.
  ///
  /// Defaults to [maxDataCodeUnits] plus seven code units for the field prefix.
  final int maxLineCodeUnits;

  StreamController<SseMessage>? _controller;
  StreamSubscription<SseMessage>? _subscription;
  Future<void>? _closing;
  http.StreamedResponse? _currentResponse;
  Timer? _idleTimer;
  Timer? _reconnectTimer;
  String? _lastEventId;
  Duration? _serverRetryDuration;
  bool _isClosed = false;
  bool _isConnecting = false;
  bool _hasEverConnected = false;
  int _reconnectAttempt = 0;

  /// Creates a new SSE client.
  ///
  /// [httpClient] - The HTTP client to use for connections.
  /// [idleTimeout] - Maximum time to wait for data before reconnecting.
  /// [backoffStrategy] - Strategy for calculating reconnection delays.
  SseClient({
    http.Client? httpClient,
    Duration idleTimeout = const Duration(seconds: 45),
    BackoffStrategy? backoffStrategy,
    int maxDataCodeUnits = 8 * 1024 * 1024,
    int? maxLineCodeUnits,
  })  : maxDataCodeUnits = maxDataCodeUnits,
        maxLineCodeUnits = SseParser(
          maxDataCodeUnits: maxDataCodeUnits,
          maxLineCodeUnits: maxLineCodeUnits,
        ).maxLineCodeUnits,
        _httpClient = httpClient ?? http.Client(),
        _idleTimeout = idleTimeout,
        _backoffStrategy = backoffStrategy ?? LegacyBackoffStrategy() {
    if (idleTimeout <= Duration.zero) {
      throw ArgumentError.value(
        idleTimeout,
        'idleTimeout',
        'idleTimeout must be positive; zero or negative values trigger an '
            'immediate reconnect storm',
      );
    }
  }

  /// Connect to an SSE endpoint and return a stream of messages.
  ///
  /// [url] - The SSE endpoint URL.
  /// [headers] - Optional additional headers to send with the request.
  /// [requestTimeout] - Optional timeout for the initial connection.
  Stream<SseMessage> connect(
    Uri url, {
    Map<String, String>? headers,
    Duration? requestTimeout,
  }) {
    if (_controller != null) {
      throw StateError('Already connected. Call close() before reconnecting.');
    }

    _isClosed = false;
    _lastEventId = null;
    _serverRetryDuration = null;
    _hasEverConnected = false;
    _reconnectAttempt = 0;
    final controller = StreamController<SseMessage>();
    _controller = controller;
    controller.onCancel = () async {
      if (_isCurrent(controller)) {
        await close();
      }
    };

    // Start the connection
    _connect(url, headers, requestTimeout);

    return controller.stream;
  }

  /// Parse an existing byte stream as SSE messages.
  ///
  /// **Stateless.** Creates a fresh [SseParser] per call; does not touch the
  /// client's reconnection state (`_lastEventId`, `_reconnectAttempt`,
  /// `_subscription`). Independent of [connect]; safe to call without a prior
  /// [connect] call or concurrently with an active [connect] session.
  ///
  /// [stream] - The byte stream to parse.
  /// [headers] - Optional response headers for context.
  Stream<SseMessage> parseStream(
    Stream<List<int>> stream, {
    Map<String, String>? headers,
  }) {
    final parser = SseParser(
      maxDataCodeUnits: maxDataCodeUnits,
      maxLineCodeUnits: maxLineCodeUnits,
    );
    return parser.parseBytes(stream);
  }

  /// Internal connection method that handles reconnection.
  Future<void> _connect(
    Uri url,
    Map<String, String>? headers,
    Duration? requestTimeout,
  ) async {
    final controller = _controller;
    if (controller == null || !_isCurrent(controller) || _isConnecting) {
      return;
    }

    _isConnecting = true;

    try {
      // Keep the subscription reachable until cancellation finishes so close()
      // can await the same cleanup while a retry is suspended here.
      await _subscription?.cancel();
      if (!_isCurrent(controller)) {
        return;
      }
      _subscription = null;

      // Prepare headers
      final requestHeaders = <String, String>{
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...?headers,
      };

      // Add Last-Event-ID header if we have one (for reconnection)
      if (_lastEventId != null) {
        requestHeaders['Last-Event-ID'] = _lastEventId!;
      }

      // Create the request
      final request = http.Request('GET', url);
      request.headers.addAll(requestHeaders);

      // Send the request with optional timeout
      final responseFuture = _httpClient.send(request);
      final response = requestTimeout != null
          ? await responseFuture.timeout(
              requestTimeout,
              onTimeout: () {
                // A Future timeout does not cancel the underlying HTTP request.
                unawaited(responseFuture.then<void>(
                  _discardResponse,
                  onError: (Object _, StackTrace __) {},
                ));
                throw TimeoutException('Future not completed', requestTimeout);
              },
            )
          : await responseFuture;

      if (!_isCurrent(controller)) {
        // The HTTP client may finish an old request after this session closed.
        await _discardResponse(response);
        return;
      }
      _currentResponse = response;

      // Check for successful response
      if (response.statusCode != 200) {
        throw Exception(
            'SSE connection failed with status ${response.statusCode}');
      }

      // Reset backoff on successful connection
      _backoffStrategy.reset();
      _reconnectAttempt = 0;
      _hasEverConnected = true;

      // Create parser for this connection
      final parser = SseParser(
        maxDataCodeUnits: maxDataCodeUnits,
        maxLineCodeUnits: maxLineCodeUnits,
      );

      // Set up idle timeout
      _resetIdleTimer(controller);

      // Parse the stream
      final messageStream = parser.parseBytes(response.stream);

      // Listen to messages
      _subscription = messageStream.listen(
        (message) {
          if (!_isCurrent(controller)) {
            return;
          }
          // Update last event ID if present
          if (message.id != null) {
            _lastEventId = message.id;
          }

          // Update retry duration if specified by server
          if (message.retry != null) {
            _serverRetryDuration = message.retry;
          }

          // Reset idle timer on each message
          _resetIdleTimer(controller);

          // Forward the message
          controller.add(message);
        },
        onError: (Object error) {
          if (_isCurrent(controller)) {
            _handleError(error, url, headers, requestTimeout);
          }
        },
        onDone: () {
          if (_isCurrent(controller)) {
            _handleDisconnection(url, headers, requestTimeout);
          }
        },
        cancelOnError: false,
      );
    } on Object catch (error) {
      if (_isCurrent(controller)) {
        _handleError(error, url, headers, requestTimeout);
      }
    } finally {
      if (_isCurrent(controller)) {
        _isConnecting = false;
      }
    }
  }

  // The controller identifies a single public connect()/close() session.
  bool _isCurrent(StreamController<SseMessage> controller) =>
      !_isClosed && identical(_controller, controller);

  Future<void> _discardResponse(http.StreamedResponse response) async {
    try {
      await response.stream.listen((_) {}, onError: (Object _) {}).cancel();
    } on Object {
      // An abandoned response must not affect the active connection.
    }
  }

  /// Reset the idle timer.
  void _resetIdleTimer(StreamController<SseMessage> controller) {
    _idleTimer?.cancel();
    _idleTimer = Timer(_idleTimeout, () {
      if (!_isCurrent(controller)) {
        return;
      }
      // Idle timeout reached, trigger reconnection
      _subscription?.cancel();
      _currentResponse = null;
      _handleDisconnection(null, null, null);
    });
  }

  /// Handle connection errors.
  void _handleError(
    Object error,
    Uri? url,
    Map<String, String>? headers,
    Duration? requestTimeout,
  ) {
    if (_isClosed) return;

    // Surface the first connection failure directly to the consumer rather than
    // entering the reconnect loop — a server that never accepted the initial
    // request is unlikely to accept a retry, and silently looping would mask
    // the root cause from the caller.
    if (!_hasEverConnected) {
      _controller?.addError(error);
      _controller?.close();
      return;
    }

    // Schedule reconnection if we have connection info
    if (url != null) {
      _scheduleReconnection(url, headers, requestTimeout);
    } else {
      _controller?.addError(error);
    }
  }

  /// Handle disconnection.
  void _handleDisconnection(
    Uri? url,
    Map<String, String>? headers,
    Duration? requestTimeout,
  ) {
    if (_isClosed) return;

    _idleTimer?.cancel();
    _subscription?.cancel();
    _currentResponse = null;

    // Schedule reconnection if we have connection info
    if (url != null) {
      _scheduleReconnection(url, headers, requestTimeout);
    }
  }

  /// Schedule a reconnection attempt.
  void _scheduleReconnection(
    Uri url,
    Map<String, String>? headers,
    Duration? requestTimeout,
  ) {
    final controller = _controller;
    if (controller == null ||
        !_isCurrent(controller) ||
        _reconnectTimer != null) {
      return;
    }

    // Calculate delay (use server retry if available, otherwise backoff)
    _reconnectAttempt++;
    final delay =
        _serverRetryDuration ?? _backoffStrategy.nextDelay(_reconnectAttempt);
    // A caller-supplied strategy may synchronously close this connection.
    if (!_isCurrent(controller)) {
      return;
    }

    // Schedule reconnection. Store the timer so close() can cancel it and
    // avoid a connect() call racing against a concurrent close().
    _reconnectTimer = Timer(delay, () {
      if (!_isCurrent(controller)) {
        return;
      }
      _reconnectTimer = null;
      _connect(url, headers, requestTimeout);
    });
  }

  /// Close the connection and clean up resources.
  Future<void> close() {
    final pending = _closing;
    if (pending != null) {
      return pending;
    }
    if (_isClosed) {
      return Future<void>.value();
    }
    final closed = Completer<void>();
    _closing = closed.future;
    closed.complete(_closeConnection());
    return closed.future;
  }

  Future<void> _closeConnection() async {
    _isClosed = true;
    _isConnecting = false;
    _idleTimer?.cancel();
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    try {
      await _subscription?.cancel();
    } finally {
      final controller = _controller;
      _subscription = null;
      _currentResponse = null;
      _controller = null;
      _closing = null;
      // A paused or absent consumer cannot hold transport cleanup open.
      unawaited(controller?.close());
      _backoffStrategy.reset();
    }
  }

  /// Check if the client is currently connected.
  bool get isConnected =>
      _controller != null && !_isClosed && _currentResponse != null;

  /// Get the last event ID received.
  String? get lastEventId => _lastEventId;
}
