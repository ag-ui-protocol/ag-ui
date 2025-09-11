import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';

/// Helper class to manage Docker-based AG-UI server for integration tests
class DockerServerLifecycle {
  static String? _containerId;
  static final List<String> _serverOutput = [];
  static StreamSubscription? _logsSubscription;

  /// Default server configuration
  static const String defaultHost = '127.0.0.1';
  static const int defaultPort = 8000;
  static const String imageName = 'ag-ui-protocol/ag-ui-server:latest';
  static const Duration startupTimeout = Duration(seconds: 30);
  static const Duration healthCheckInterval = Duration(milliseconds: 500);

  /// Get the base URL for the server (can be overridden by AGUI_BASE_URL env var)
  static String get baseUrl {
    return Platform.environment['AGUI_BASE_URL'] ??
        'http://$defaultHost:$defaultPort';
  }

  /// Start the Docker-based AG-UI server
  static Future<void> startServer() async {
    if (_containerId != null) {
      print('Server container already running');
      return;
    }

    // Skip if integration tests are disabled
    if (Platform.environment['AGUI_SKIP_INTEGRATION'] == '1') {
      print('Skipping server start (AGUI_SKIP_INTEGRATION=1)');
      return;
    }

    print('Starting AG-UI server using Docker...');
    _serverOutput.clear();

    try {
      // Check if Docker is available
      final dockerCheck = await Process.run('docker', ['version']);
      if (dockerCheck.exitCode != 0) {
        throw Exception('Docker is not available. Please install Docker.');
      }

      // Check if image exists
      final imageCheck = await Process.run(
        'docker',
        ['images', '-q', imageName],
      );
      
      if (imageCheck.stdout.toString().trim().isEmpty) {
        print('Docker image $imageName not found. Pulling...');
        final pullResult = await Process.run(
          'docker',
          ['pull', imageName],
        );
        if (pullResult.exitCode != 0) {
          throw Exception('Failed to pull Docker image: ${pullResult.stderr}');
        }
      }

      // Start the container
      final runResult = await Process.run(
        'docker',
        [
          'run',
          '--rm',
          '-d',
          '--name', 'ag-ui-dart-test-server',
          '-p', '$defaultPort:8000',
          imageName,
        ],
      );

      if (runResult.exitCode != 0) {
        // Check if container already exists
        if (runResult.stderr.toString().contains('already in use')) {
          print('Container already exists. Stopping and removing...');
          await stopServer();
          // Retry
          return startServer();
        }
        throw Exception('Failed to start container: ${runResult.stderr}');
      }

      _containerId = runResult.stdout.toString().trim();
      print('Container started with ID: $_containerId');

      // Start capturing logs
      _startLogCapture();

      // Wait for server to be ready
      await _waitForServerReady();
      print('Server started successfully at $baseUrl');
    } catch (e) {
      await stopServer();
      throw Exception('Failed to start Docker server: $e');
    }
  }

  /// Start capturing container logs
  static void _startLogCapture() {
    if (_containerId == null) return;

    final process = Process.start(
      'docker',
      ['logs', '-f', 'ag-ui-dart-test-server'],
    );

    process.then((proc) {
      _logsSubscription = proc.stdout
          .transform(const SystemEncoding().decoder)
          .listen((data) {
        _serverOutput.add('[STDOUT] $data');
        if (Platform.environment['AGUI_DEBUG'] == '1') {
          print('Server: $data');
        }
      });

      proc.stderr
          .transform(const SystemEncoding().decoder)
          .listen((data) {
        _serverOutput.add('[STDERR] $data');
        if (Platform.environment['AGUI_DEBUG'] == '1') {
          print('Server Error: $data');
        }
      });
    });
  }

  /// Wait for the server to be ready by checking health/docs endpoint
  static Future<void> _waitForServerReady() async {
    final stopwatch = Stopwatch()..start();
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 2);

    while (stopwatch.elapsed < startupTimeout) {
      try {
        // Try to connect to the docs endpoint (FastAPI always has this)
        final request = await client.getUrl(Uri.parse('$baseUrl/docs'));
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

  /// Stop the Docker container
  static Future<void> stopServer() async {
    if (_containerId == null) {
      return;
    }

    print('Stopping Docker container...');

    // Cancel log subscription
    await _logsSubscription?.cancel();

    // Stop the container
    final stopResult = await Process.run(
      'docker',
      ['stop', 'ag-ui-dart-test-server'],
    );

    if (stopResult.exitCode == 0) {
      print('Container stopped successfully');
    } else {
      print('Warning: Failed to stop container: ${stopResult.stderr}');
      
      // Try to force remove
      await Process.run(
        'docker',
        ['rm', '-f', 'ag-ui-dart-test-server'],
      );
    }

    _containerId = null;
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
  static bool get isRunning => _containerId != null;

  /// Check if a container is already running
  static Future<bool> isContainerRunning() async {
    final result = await Process.run(
      'docker',
      ['ps', '-q', '-f', 'name=ag-ui-dart-test-server'],
    );
    return result.stdout.toString().trim().isNotEmpty;
  }

  /// Setup test group with Docker server lifecycle
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
        
        // Check if container is already running (from previous test run)
        if (await isContainerRunning()) {
          print('Reusing existing container');
          _containerId = 'existing';
          return;
        }
        
        await startServer();
      });

      tearDownAll(() async {
        if (skipIfDisabled &&
            Platform.environment['AGUI_SKIP_INTEGRATION'] == '1') {
          return;
        }
        
        // Only stop if we started it (not reusing existing)
        if (_containerId != null && _containerId != 'existing') {
          // Save logs before stopping
          final timestamp = DateTime.now().millisecondsSinceEpoch;
          await saveServerLogs(
            'test/integration/artifacts/docker_server_logs_$timestamp.txt',
          );
          await stopServer();
        }
      });

      body();
    });
  }
}