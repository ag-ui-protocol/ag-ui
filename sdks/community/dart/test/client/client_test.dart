import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

import 'package:ag_ui/src/client/client.dart';
import 'package:ag_ui/src/client/config.dart';
import 'package:ag_ui/src/client/errors.dart';
import 'package:ag_ui/src/types/types.dart';
import 'package:ag_ui/src/events/events.dart';
import 'package:ag_ui/src/sse/backoff_strategy.dart';
import 'package:ag_ui/src/encoder/client_codec.dart' as codec;

void main() {
  group('AgUiClient', () {
    late AgUiClient client;
    late MockClient mockHttpClient;
    
    setUp(() {
      mockHttpClient = MockClient((request) async {
        // Default mock response
        return http.Response('{"success": true}', 200);
      });
    });

    tearDown(() async {
      await client.close();
    });

    group('startRun', () {
      test('sends correct request and parses response', () async {
        final expectedRunId = 'run_123';
        final expectedSessionId = 'session_456';
        
        mockHttpClient = MockClient((request) async {
          expect(request.method, equals('POST'));
          expect(request.url.toString(), equals('https://api.example.com/runs'));
          expect(request.headers['Content-Type'], startsWith('application/json'));
          
          final body = json.decode(request.body) as Map<String, dynamic>;
          expect(body['input'], equals({'message': 'Hello'}));
          expect(body['config'], equals({'temperature': 0.7}));
          
          return http.Response(
            json.encode({
              'runId': expectedRunId,
              'sessionId': expectedSessionId,
              'metadata': {'version': '1.0'},
            }),
            200,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(baseUrl: 'https://api.example.com'),
          httpClient: mockHttpClient,
        );

        final response = await client.startRun(
          StartRunRequest(
            input: {'message': 'Hello'},
            config: {'temperature': 0.7},
          ),
        );

        expect(response.runId, equals(expectedRunId));
        expect(response.sessionId, equals(expectedSessionId));
        expect(response.metadata, equals({'version': '1.0'}));
      });

      test('handles server errors with retry', () async {
        int attempts = 0;
        mockHttpClient = MockClient((request) async {
          attempts++;
          if (attempts < 2) {
            return http.Response('Server error', 500);
          }
          return http.Response(
            json.encode({'runId': 'run_123'}),
            200,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'https://api.example.com',
            maxRetries: 2,
          ),
          httpClient: mockHttpClient,
        );

        final response = await client.startRun(StartRunRequest());
        expect(response.runId, equals('run_123'));
        expect(attempts, equals(2));
      });

      test('throws exception after max retries', () async {
        mockHttpClient = MockClient((request) async {
          return http.Response('Server error', 500);
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'https://api.example.com',
            maxRetries: 1,
          ),
          httpClient: mockHttpClient,
        );

        expect(
          () => client.startRun(StartRunRequest()),
          throwsA(isA<AgUiHttpException>()),
        );
      });
    });

    group('sendMessage', () {
      test('sends user message successfully', () async {
        final runId = 'run_123';
        final messageId = 'msg_456';
        
        mockHttpClient = MockClient((request) async {
          expect(request.method, equals('POST'));
          expect(request.url.toString(), 
            equals('https://api.example.com/runs/$runId/messages'));
          
          final body = json.decode(request.body) as Map<String, dynamic>;
          expect(body['content'], equals('Hello AI'));
          expect(body['role'], equals('user'));
          
          return http.Response(
            json.encode({
              'messageId': messageId,
              'success': true,
            }),
            200,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(baseUrl: 'https://api.example.com'),
          httpClient: mockHttpClient,
        );

        final message = UserMessage(
          id: 'user_msg_1',
          content: 'Hello AI',
        );

        final response = await client.sendMessage(runId, message);
        expect(response.messageId, equals(messageId));
        expect(response.success, isTrue);
      });
    });

    group('submitToolResult', () {
      test('submits tool result successfully', () async {
        final runId = 'run_123';
        final toolCallId = 'tool_456';
        
        mockHttpClient = MockClient((request) async {
          expect(request.method, equals('POST'));
          expect(request.url.toString(), 
            equals('https://api.example.com/runs/$runId/tools/$toolCallId/result'));
          
          final body = json.decode(request.body) as Map<String, dynamic>;
          expect(body['toolCallId'], equals(toolCallId));
          expect(body['result'], equals({'data': 'result value'}));
          
          return http.Response(
            json.encode({
              'success': true,
              'message': 'Tool result received',
            }),
            200,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(baseUrl: 'https://api.example.com'),
          httpClient: mockHttpClient,
        );

        final result = codec.ToolResult(
          toolCallId: toolCallId,
          result: {'data': 'result value'},
        );

        final response = await client.submitToolResult(runId, toolCallId, result);
        expect(response.success, isTrue);
        expect(response.message, equals('Tool result received'));
      });
    });

    group('cancelRun', () {
      test('cancels run successfully', () async {
        final runId = 'run_123';
        
        mockHttpClient = MockClient((request) async {
          expect(request.method, equals('POST'));
          expect(request.url.toString(), 
            equals('https://api.example.com/runs/$runId/cancel'));
          
          return http.Response('', 204);
        });

        client = AgUiClient(
          config: AgUiClientConfig(baseUrl: 'https://api.example.com'),
          httpClient: mockHttpClient,
        );

        await client.cancelRun(runId);
        // No exception means success
      });

      test('throws exception on failure', () async {
        final runId = 'run_123';
        
        mockHttpClient = MockClient((request) async {
          return http.Response('Cannot cancel', 400);
        });

        client = AgUiClient(
          config: AgUiClientConfig(baseUrl: 'https://api.example.com'),
          httpClient: mockHttpClient,
        );

        expect(
          () => client.cancelRun(runId),
          throwsA(isA<AgUiHttpException>()),
        );
      });
    });

    group('streamEvents', () {
      test('creates SSE stream for events', () async {
        final runId = 'run_123';
        
        // Note: Full SSE streaming test would require more complex mocking
        // This is a basic structure test
        client = AgUiClient(
          config: AgUiClientConfig(baseUrl: 'https://api.example.com'),
          httpClient: mockHttpClient,
        );

        final stream = client.streamEvents(runId);
        expect(stream, isA<Stream<BaseEvent>>());
        
        // Clean up the stream
        stream.listen((_) {}).cancel();
      });
    });

    group('error handling', () {
      test('handles timeout errors', () async {
        mockHttpClient = MockClient((request) async {
          await Future.delayed(Duration(seconds: 5));
          return http.Response('', 200);
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'https://api.example.com',
            requestTimeout: Duration(milliseconds: 100),
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );

        expect(
          () => client.startRun(StartRunRequest()),
          throwsA(isA<TimeoutError>()),
        );
      });

      test('includes response body in error', () async {
        final errorMessage = 'Invalid request parameters';
        
        mockHttpClient = MockClient((request) async {
          return http.Response(
            json.encode({'error': errorMessage}),
            400,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'https://api.example.com',
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );

        try {
          await client.startRun(StartRunRequest());
          fail('Should have thrown exception');
        } on TransportError catch (e) {
          expect(e.statusCode, equals(400));
          expect(e.responseBody, contains(errorMessage));
          expect(e.endpoint, contains('/runs'));
        }
      });
    });

    group('configuration', () {
      test('uses default headers', () async {
        mockHttpClient = MockClient((request) async {
          expect(request.headers['X-API-Key'], equals('test-key'));
          expect(request.headers['Accept'], contains('application/json'));
          return http.Response(json.encode({'runId': 'run_123'}), 200);
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'https://api.example.com',
            defaultHeaders: {'X-API-Key': 'test-key'},
          ),
          httpClient: mockHttpClient,
        );

        await client.startRun(StartRunRequest());
      });

      test('respects custom backoff strategy', () async {
        int attempts = 0;
        final delays = <Duration>[];
        
        mockHttpClient = MockClient((request) async {
          attempts++;
          if (attempts < 3) {
            return http.Response('Server error', 500);
          }
          return http.Response(json.encode({'runId': 'run_123'}), 200);
        });

        // Custom backoff that tracks delays
        final customBackoff = TestBackoffStrategy(
          onNextDelay: (attempt) {
            final delay = Duration(milliseconds: attempt * 10);
            delays.add(delay);
            return delay;
          },
        );

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'https://api.example.com',
            backoffStrategy: customBackoff,
            maxRetries: 3,
          ),
          httpClient: mockHttpClient,
        );

        await client.startRun(StartRunRequest());
        expect(attempts, equals(3));
        expect(delays.length, equals(2)); // 2 retries = 2 delays
      });
    });
  });
}

// Test helper for custom backoff strategy
class TestBackoffStrategy implements BackoffStrategy {
  final Duration Function(int attempt) onNextDelay;
  
  TestBackoffStrategy({required this.onNextDelay});
  
  @override
  Duration nextDelay(int attempt) => onNextDelay(attempt);
  
  @override
  void reset() {}
}