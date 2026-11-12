import 'dart:async';

import 'package:ag_ui/ag_ui.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'ids.dart';

class AgUiService {
  final http.Client _httpClient;
  final String baseUrl;
  final StreamController<ConnectionStatus> _connectionController =
      StreamController<ConnectionStatus>.broadcast();
  final Set<_ActiveRun> _runs = {};
  bool _disposed = false;
  Future<void>? _closeFuture;

  Stream<ConnectionStatus> get connectionStatus => _connectionController.stream;

  /// The service owns [httpClient], including closing it on disposal.
  AgUiService({String? baseUrl, http.Client? httpClient})
    : _httpClient = httpClient ?? http.Client(),
      baseUrl =
          baseUrl ??
          const String.fromEnvironment(
            'AG_UI_BASE_URL',
            defaultValue: 'http://127.0.0.1:8080',
          ) {
    _emitStatus(ConnectionStatus.disconnected);
  }

  void _emitStatus(ConnectionStatus status) {
    if (!_disposed) _connectionController.add(status);
  }

  /// One run, caller-owned history. The caller passes the full message list each
  /// time, including on tool-result continuations.
  Stream<BaseEvent> run(
    String endpoint, {
    required String threadId,
    required List<Message> messages,
    List<Tool> tools = const [],
    dynamic state,
    Map<String, String> extraQuery = const {},
  }) {
    final runId = uid('run');
    final input = SimpleRunAgentInput(
      threadId: threadId,
      runId: runId,
      messages: messages,
      tools: tools,
      context: const [],
      state: state ?? <String, dynamic>{},
      forwardedProps: <String, dynamic>{},
    );
    final path = extraQuery.isEmpty
        ? endpoint
        : '$endpoint?${extraQuery.entries.map((e) => '${e.key}=${Uri.encodeQueryComponent(e.value)}').join('&')}';
    late final _ActiveRun active;
    late final StreamController<BaseEvent> output;

    void finish() {
      _runs.remove(active);
      _emitStatus(ConnectionStatus.disconnected);
      unawaited(output.close());
    }

    output = StreamController<BaseEvent>(
      onListen: () {
        if (_disposed) {
          output.addError(StateError('AgUiService is closed'));
          unawaited(output.close());
          return;
        }
        _runs.add(active);
        _emitStatus(ConnectionStatus.connecting);
        try {
          active.subscription = active.client
              .runAgent(path, input, cancelToken: active.token)
              .listen(
                (event) {
                  if (!_disposed && !active.stopped) output.add(event);
                },
                onError: (Object error, StackTrace stack) {
                  if (!_disposed && !active.stopped) {
                    _emitStatus(ConnectionStatus.error);
                    output.addError(error, stack);
                  }
                },
                onDone: finish,
              );
          _emitStatus(ConnectionStatus.connected);
        } catch (error, stack) {
          _emitStatus(ConnectionStatus.error);
          output.addError(error, stack);
          finish();
        }
      },
      onCancel: () async {
        try {
          await active.stop();
        } catch (error) {
          // StreamController invokes onCancel on normal completion too. Do not
          // leak a failed automatic cleanup future into the event zone; an
          // explicit service.close() still observes the run's cleanup failure.
          debugPrint('Error stopping AG-UI run: $error');
        } finally {
          _runs.remove(active);
        }
      },
      onPause: () => active.subscription?.pause(),
      onResume: () => active.subscription?.resume(),
    );
    active = _ActiveRun(
      baseUrl: baseUrl,
      httpClient: _httpClient,
      closeOutput: () => unawaited(output.close()),
    );
    return output.stream;
  }

  Stream<BaseEvent> sendMessage(String endpoint, String message) => run(
    endpoint,
    threadId: uid('thread'),
    messages: [UserMessage(id: uid('user'), content: message)],
  );

  Stream<BaseEvent> sendMultimodalMessage(
    String endpoint,
    List<InputContent> parts,
  ) => run(
    endpoint,
    threadId: uid('thread'),
    messages: [UserMessage.multimodal(id: uid('user'), parts: parts)],
  );

  /// Stops new events and returns the shared transport-cleanup future.
  Future<void> close() {
    if (_closeFuture != null) return _closeFuture!;
    _disposed = true;
    final runs = _runs.toList();
    _runs.clear();
    final cleanup = <Future<void>>[];
    for (final run in runs) {
      cleanup.add(run.stop());
      run.closeOutput();
    }
    // Cancel owned response bodies before closing the shared transport. This
    // wakes idle parsers with EOF rather than a socket error.
    _closeFuture = Future.wait(cleanup).then<void>((_) {}).whenComplete(() {
      _httpClient.close();
      // A paused status listener must not keep transport cleanup alive.
      unawaited(_connectionController.close());
    });
    return _closeFuture!;
  }

  void dispose() {
    unawaited(
      close().catchError((Object error, StackTrace stack) {
        debugPrint('Error closing AG-UI service: $error');
      }),
    );
  }
}

class _ActiveRun {
  final CancelToken token = CancelToken();
  late final _OwnedResponseClient transport;
  late final AgUiClient client;
  final void Function() closeOutput;
  StreamSubscription<BaseEvent>? subscription;
  Future<void>? _stopFuture;
  bool stopped = false;

  _ActiveRun({
    required String baseUrl,
    required http.Client httpClient,
    required this.closeOutput,
  }) {
    transport = _OwnedResponseClient(httpClient);
    client = AgUiClient(
      config: AgUiClientConfig(baseUrl: baseUrl),
      httpClient: transport,
    );
  }

  Future<void> stop() {
    if (_stopFuture != null) return _stopFuture!;
    stopped = true;
    token.cancel();
    return _stopFuture = _stop();
  }

  Future<void> _stop() async {
    try {
      // Cancelling an async* subscription alone does not interrupt an await
      // for another SSE byte. Own and close the raw body first.
      final responseCleanup = transport.cancelResponse();
      await Future.wait([responseCleanup, _cancelSubscription()]);
    } finally {
      await client.close();
    }
  }

  Future<void> _cancelSubscription() async {
    try {
      await subscription?.cancel();
    } catch (_) {
      // Deliberate cancellation can surface a token or transport error through
      // cancel(), including a non-2xx response completed by our graceful EOF.
      // The caller stopped this stream; raw transport cleanup failures are
      // still reported separately through responseCleanup.
    }
  }
}

/// Each run owns its response while the service owns the shared HTTP client.
/// Keeping those lifetimes separate also lets callers cancel one concurrent run
/// without stopping another.
class _OwnedResponseClient extends http.BaseClient {
  final http.Client _delegate;
  _OwnedResponseBody? _body;
  bool _closed = false;

  _OwnedResponseClient(this._delegate);

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (_closed) throw http.ClientException('AG-UI run is closed', request.url);
    final response = await _delegate.send(request);
    final body = _OwnedResponseBody(response.stream);
    _body = body;
    if (_closed) await body.cancel();
    return http.StreamedResponse(
      body.stream,
      response.statusCode,
      contentLength: response.contentLength,
      request: response.request,
      headers: response.headers,
      isRedirect: response.isRedirect,
      persistentConnection: response.persistentConnection,
      reasonPhrase: response.reasonPhrase,
    );
  }

  Future<void> cancelResponse() {
    _closed = true;
    return _body?.cancel() ?? Future<void>.value();
  }

  @override
  void close() {
    // The run awaits cancelResponse explicitly. This synchronous SDK hook must
    // not create a second, unhandled branch of the same cleanup failure.
    unawaited(cancelResponse().catchError((Object _) {}));
  }
}

class _OwnedResponseBody {
  final Stream<List<int>> _source;
  late final StreamController<List<int>> _controller;
  StreamSubscription<List<int>>? _subscription;
  Future<void>? _cancelFuture;
  bool _cancelled = false;

  _OwnedResponseBody(this._source) {
    _controller = StreamController<List<int>>(
      onListen: _listen,
      onCancel: () => cancel().catchError((Object _) {}),
      onPause: () => _subscription?.pause(),
      onResume: () => _subscription?.resume(),
    );
  }

  Stream<List<int>> get stream => _controller.stream;

  void _listen() {
    if (_cancelled) return;
    _subscription = _source.listen(
      _controller.add,
      onError: _controller.addError,
      onDone: () => unawaited(_controller.close()),
    );
  }

  Future<void> cancel() {
    if (_cancelFuture != null) return _cancelFuture!;
    _cancelled = true;
    // Even a late response that the SDK never consumed must release its socket.
    final subscription = _subscription ?? _source.listen((_) {});
    _subscription = null;
    _cancelFuture = subscription.cancel();
    // Do not await delivery of done: a paused downstream listener can delay it.
    unawaited(_controller.close());
    return _cancelFuture!;
  }
}

enum ConnectionStatus { connected, connecting, disconnected, error }
