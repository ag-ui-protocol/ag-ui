import 'package:test/test.dart';
import 'package:ag_ui/src/sse/backoff_strategy.dart';

void main() {
  group('BackoffStrategy', () {
    test('calculates exponential backoff correctly', () {
      final backoff = BackoffStrategy(
        initialDelay: Duration(seconds: 1),
        maxDelay: Duration(seconds: 30),
        multiplier: 2.0,
        jitterFactor: 0.0, // No jitter for predictable testing
      );

      // First attempt: 1s
      expect(backoff.nextDelay(), Duration(seconds: 1));
      expect(backoff.attempt, 1);

      // Second attempt: 2s
      expect(backoff.nextDelay(), Duration(seconds: 2));
      expect(backoff.attempt, 2);

      // Third attempt: 4s
      expect(backoff.nextDelay(), Duration(seconds: 4));
      expect(backoff.attempt, 3);

      // Fourth attempt: 8s
      expect(backoff.nextDelay(), Duration(seconds: 8));
      expect(backoff.attempt, 4);

      // Fifth attempt: 16s
      expect(backoff.nextDelay(), Duration(seconds: 16));
      expect(backoff.attempt, 5);

      // Sixth attempt: 32s, but capped at 30s
      expect(backoff.nextDelay(), Duration(seconds: 30));
      expect(backoff.attempt, 6);

      // Seventh attempt: still capped at 30s
      expect(backoff.nextDelay(), Duration(seconds: 30));
      expect(backoff.attempt, 7);
    });

    test('applies jitter within expected bounds', () {
      final backoff = BackoffStrategy(
        initialDelay: Duration(seconds: 10),
        maxDelay: Duration(seconds: 100),
        multiplier: 1.0, // Keep delay constant to test jitter
        jitterFactor: 0.3, // ±30% jitter
      );

      // Run multiple times to test jitter randomness
      for (var i = 0; i < 20; i++) {
        backoff.reset();
        final delay = backoff.nextDelay();
        final delayMs = delay.inMilliseconds;
        
        // Expected: 10000ms ± 30% = 7000ms to 13000ms
        expect(delayMs, greaterThanOrEqualTo(7000));
        expect(delayMs, lessThanOrEqualTo(13000));
      }
    });

    test('reset() resets attempt counter', () {
      final backoff = BackoffStrategy(
        initialDelay: Duration(seconds: 1),
        jitterFactor: 0.0,
      );

      // Make several attempts
      backoff.nextDelay();
      backoff.nextDelay();
      backoff.nextDelay();
      expect(backoff.attempt, 3);

      // Reset
      backoff.reset();
      expect(backoff.attempt, 0);

      // Next delay should be initial delay again
      expect(backoff.nextDelay(), Duration(seconds: 1));
      expect(backoff.attempt, 1);
    });

    test('handles custom multiplier', () {
      final backoff = BackoffStrategy(
        initialDelay: Duration(milliseconds: 100),
        maxDelay: Duration(seconds: 10),
        multiplier: 3.0,
        jitterFactor: 0.0,
      );

      expect(backoff.nextDelay(), Duration(milliseconds: 100)); // 100
      expect(backoff.nextDelay(), Duration(milliseconds: 300)); // 100 * 3
      expect(backoff.nextDelay(), Duration(milliseconds: 900)); // 100 * 3^2
      expect(backoff.nextDelay(), Duration(milliseconds: 2700)); // 100 * 3^3
    });

    test('never returns negative delay with jitter', () {
      final backoff = BackoffStrategy(
        initialDelay: Duration(milliseconds: 10),
        maxDelay: Duration(seconds: 1),
        multiplier: 1.0,
        jitterFactor: 0.99, // Very high jitter
      );

      // Even with high jitter, delay should never be negative
      for (var i = 0; i < 50; i++) {
        backoff.reset();
        final delay = backoff.nextDelay();
        expect(delay.inMilliseconds, greaterThanOrEqualTo(0));
      }
    });

    test('caps at maxDelay even with jitter', () {
      final backoff = BackoffStrategy(
        initialDelay: Duration(seconds: 25),
        maxDelay: Duration(seconds: 30),
        multiplier: 2.0,
        jitterFactor: 0.5, // ±50% jitter
      );

      // Skip to where we'd be at or above max
      backoff.nextDelay();
      backoff.nextDelay();
      
      // Even with jitter, should not exceed maxDelay + jitter range
      for (var i = 0; i < 10; i++) {
        final delay = backoff.nextDelay();
        // Max delay is 30s, with ±50% jitter: max possible is 30s + 15s = 45s
        expect(delay.inMilliseconds, lessThanOrEqualTo(45000));
      }
    });

    test('uses default values correctly', () {
      final backoff = BackoffStrategy();

      // Default: 1s initial, 30s max, 2.0 multiplier, 0.3 jitter
      final firstDelay = backoff.nextDelay();
      
      // With jitter, should be roughly 1s ± 30%
      expect(firstDelay.inMilliseconds, greaterThanOrEqualTo(700));
      expect(firstDelay.inMilliseconds, lessThanOrEqualTo(1300));
    });
  });
}