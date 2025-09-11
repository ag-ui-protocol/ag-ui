import 'dart:async';
import 'dart:io';
import 'package:test/test.dart';

/// Helper class to manage Python server lifecycle for integration tests
class ServerLifecycle {
  static Process? _serverProcess;
  static final List<String> _serverOutput = [];
  static StreamSubscription? _stdoutSubscription;
  static StreamSubscription? _stderrSubscription;

  /// Default server configuration
  static const String defaultHost = '127.0.0.1';
  static const int defaultPort = 20203;
  static const Duration startupTimeout = Duration(seconds: 30);
  static const Duration healthCheckInterval = Duration(milliseconds: 500);

  /// Get the base URL for the server (can be overridden by AGUI_BASE_URL env var)
  static String get baseUrl {
    return Platform.environment['AGUI_BASE_URL'] ??
        'http://$defaultHost:$defaultPort';
  }

  /// Start the Python example server
  static Future<void> startServer() async {
    if (_serverProcess != null) {
      print('Server already running');
      return;
    }

    // Skip if integration tests are disabled
    if (Platform.environment['AGUI_SKIP_INTEGRATION'] == '1') {
      print('Skipping server start (AGUI_SKIP_INTEGRATION=1)');
      return;
    }

    print('Starting Python example server...');
    _serverOutput.clear();

    // Path to the Python server script
    final serverPath = '${Directory.current.path}/typescript-sdk/integrations/'
        'server-starter-all-features/server/python';

    // Check if server directory exists
    final serverDir = Directory(serverPath);
    if (!await serverDir.exists()) {
      throw Exception('Server directory not found: $serverPath');
    }

    try {
      // Start the server process
      _serverProcess = await Process.start(
        'python',
        ['-m', 'uvicorn', 'example_server.app:app', '--port', '$defaultPort'],
        workingDirectory: serverPath,
        environment: {
          ...Platform.environment,
          'PYTHONUNBUFFERED': '1',
        },
      );

      // Capture server output
      _stdoutSubscription = _serverProcess!.stdout
          .transform(const SystemEncoding().decoder)
          .listen((data) {
        _serverOutput.add('[STDOUT] $data');
        print('Server: $data');
      });

      _stderrSubscription = _serverProcess!.stderr
          .transform(const SystemEncoding().decoder)
          .listen((data) {
        _serverOutput.add('[STDERR] $data');
        print('Server Error: $data');
      });

      // Wait for server to be ready
      await _waitForServerReady();
      print('Server started successfully at $baseUrl');
    } catch (e) {
      await stopServer();
      throw Exception('Failed to start server: $e');
    }
  }

  /// Wait for the server to be ready by checking health endpoint
  static Future<void> _waitForServerReady() async {
    final stopwatch = Stopwatch()..start();
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 2);

    while (stopwatch.elapsed < startupTimeout) {
      try {
        // Try to connect to the health endpoint
        final request = await client.getUrl(Uri.parse('$baseUrl/health'));
        final response = await request.close();
        if (response.statusCode == 200) {
          client.close();
          return; // Server is ready
        }
      } catch (e) {
        // Server not ready yet, continue waiting
      }

      await Future.delayed(healthCheckInterval);
    }

    client.close();
    throw TimeoutException(
      'Server did not start within ${startupTimeout.inSeconds} seconds',
    );
  }

  /// Stop the Python server
  static Future<void> stopServer() async {
    if (_serverProcess == null) {
      return;
    }

    print('Stopping Python server...');

    // Cancel output subscriptions
    await _stdoutSubscription?.cancel();
    await _stderrSubscription?.cancel();

    // Try graceful shutdown first
    _serverProcess!.kill(ProcessSignal.sigterm);

    // Wait for process to exit
    final exitCode = await _serverProcess!.exitCode
        .timeout(const Duration(seconds: 5), onTimeout: () {
      // Force kill if graceful shutdown fails
      _serverProcess!.kill(ProcessSignal.sigkill);
      return -1;
    });

    print('Server stopped with exit code: $exitCode');
    _serverProcess = null;
  }

  /// Get server output logs
  static List<String> getServerLogs() => List.unmodifiable(_serverOutput);

  /// Save server logs to a file
  static Future<void> saveServerLogs(String filepath) async {
    final file = File(filepath);
    await file.writeAsString(_serverOutput.join('\n'));
    print('Server logs saved to: $filepath');
  }

  /// Check if the server is currently running
  static bool get isRunning => _serverProcess != null;

  /// Setup test group with server lifecycle
  static void withServer(
    String description,
    void Function() body, {
    bool skipIfDisabled = true,
  }) {
    group(description, () {
      setUpAll(() async {
        if (skipIfDisabled &&
            Platform.environment['AGUI_SKIP_INTEGRATION'] == '1') {
          print('Skipping integration tests (AGUI_SKIP_INTEGRATION=1)');
          return;
        }
        await startServer();
      });

      tearDownAll(() async {
        if (skipIfDisabled &&
            Platform.environment['AGUI_SKIP_INTEGRATION'] == '1') {
          return;
        }
        // Save logs before stopping
        final timestamp = DateTime.now().millisecondsSinceEpoch;
        await saveServerLogs(
          'test/integration/artifacts/server_logs_$timestamp.txt',
        );
        await stopServer();
      });

      body();
    });
  }
}