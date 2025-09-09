import 'dart:math';

/// Implements exponential backoff with jitter for reconnection attempts.
class BackoffStrategy {
  final Duration initialDelay;
  final Duration maxDelay;
  final double multiplier;
  final double jitterFactor;
  final Random _random = Random();

  int _attempt = 0;

  BackoffStrategy({
    this.initialDelay = const Duration(seconds: 1),
    this.maxDelay = const Duration(seconds: 30),
    this.multiplier = 2.0,
    this.jitterFactor = 0.3,
  });

  /// Calculate the next delay with exponential backoff and jitter.
  Duration nextDelay() {
    // Calculate base delay with exponential backoff
    final baseDelayMs = initialDelay.inMilliseconds * pow(multiplier, _attempt);
    
    // Cap at max delay
    final cappedDelayMs = min(baseDelayMs, maxDelay.inMilliseconds);
    
    // Add jitter (±jitterFactor * delay)
    final jitterRange = cappedDelayMs * jitterFactor;
    final jitter = (_random.nextDouble() * 2 - 1) * jitterRange;
    final finalDelayMs = max(0, cappedDelayMs + jitter);
    
    _attempt++;
    return Duration(milliseconds: finalDelayMs.round());
  }

  /// Reset the backoff counter.
  void reset() {
    _attempt = 0;
  }

  /// Get the current attempt number.
  int get attempt => _attempt;
}