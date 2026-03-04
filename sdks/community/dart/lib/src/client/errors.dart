/// Base class for all AG-UI errors
abstract class AgUiError implements Exception {
  /// Human-readable error message
  final String message;

  /// Optional error details for debugging
  final Map<String, dynamic>? details;

  /// Original error that caused this error
  final Object? cause;

  const AgUiError(
    this.message, {
    this.details,
    this.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('$runtimeType: $message');
    if (details != null && details!.isNotEmpty) {
      buffer.write(' (details: $details)');
    }
    if (cause != null) {
      buffer.write('\nCaused by: $cause');
    }
    return buffer.toString();
  }
}

/// Error during HTTP/SSE transport operations
class TransportError extends AgUiError {
  /// HTTP status code if applicable
  final int? statusCode;

  /// Request URL/endpoint
  final String? endpoint;

  /// Response body excerpt if available
  final String? responseBody;

  const TransportError(
    super.message, {
    this.statusCode,
    this.endpoint,
    this.responseBody,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('TransportError: $message');
    if (endpoint != null) {
      buffer.write(' (endpoint: $endpoint)');
    }
    if (statusCode != null) {
      buffer.write(' (status: $statusCode)');
    }
    if (responseBody != null) {
      final excerpt = responseBody!.length > 200
          ? '${responseBody!.substring(0, 200)}...'
          : responseBody;
      buffer.write('\nResponse: $excerpt');
    }
    if (cause != null) {
      buffer.write('\nCaused by: $cause');
    }
    return buffer.toString();
  }
}

/// Error when operation times out
class TimeoutError extends AgUiError {
  /// Duration that was exceeded
  final Duration? timeout;

  /// Operation that timed out
  final String? operation;

  const TimeoutError(
    super.message, {
    this.timeout,
    this.operation,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('TimeoutError: $message');
    if (operation != null) {
      buffer.write(' (operation: $operation)');
    }
    if (timeout != null) {
      buffer.write(' (timeout: ${timeout!.inSeconds}s)');
    }
    return buffer.toString();
  }
}

/// Error when operation is cancelled
class CancellationError extends AgUiError {
  /// Operation that was cancelled
  final String? operation;
  
  /// Reason for cancellation
  final String? reason;

  const CancellationError(
    super.message, {
    this.operation,
    this.reason,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('CancellationError: $message');
    if (operation != null) {
      buffer.write(' (operation: $operation)');
    }
    if (reason != null) {
      buffer.write(' (reason: $reason)');
    }
    return buffer.toString();
  }
}

/// Error decoding JSON or event data
class DecodingError extends AgUiError {
  /// Field or path that failed to decode
  final String? field;

  /// Expected type or format
  final String? expectedType;

  /// Actual value that failed to decode
  final dynamic actualValue;

  const DecodingError(
    super.message, {
    this.field,
    this.expectedType,
    this.actualValue,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('DecodingError: $message');
    if (field != null) {
      buffer.write(' (field: $field)');
    }
    if (expectedType != null) {
      buffer.write(' (expected: $expectedType)');
    }
    if (actualValue != null) {
      buffer.write(' (actual: ${actualValue.runtimeType})');
    }
    return buffer.toString();
  }
}

/// Error validating input or output data
class ValidationError extends AgUiError {
  /// Field that failed validation
  final String? field;

  /// Validation constraint that failed
  final String? constraint;

  /// Invalid value
  final dynamic value;

  const ValidationError(
    super.message, {
    this.field,
    this.constraint,
    this.value,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('ValidationError: $message');
    if (field != null) {
      buffer.write(' (field: $field)');
    }
    if (constraint != null) {
      buffer.write(' (constraint: $constraint)');
    }
    if (value != null) {
      final valueStr = value.toString();
      final excerpt = valueStr.length > 100
          ? '${valueStr.substring(0, 100)}...'
          : valueStr;
      buffer.write(' (value: $excerpt)');
    }
    return buffer.toString();
  }
}

/// Error when protocol rules are violated
class ProtocolViolationError extends AgUiError {
  /// Protocol rule that was violated
  final String? rule;

  /// Current state when violation occurred
  final String? state;

  /// Expected sequence or behavior
  final String? expected;

  const ProtocolViolationError(
    super.message, {
    this.rule,
    this.state,
    this.expected,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('ProtocolViolationError: $message');
    if (rule != null) {
      buffer.write(' (rule: $rule)');
    }
    if (state != null) {
      buffer.write(' (state: $state)');
    }
    if (expected != null) {
      buffer.write(' (expected: $expected)');
    }
    return buffer.toString();
  }
}

/// Server-side application error
class ServerError extends AgUiError {
  /// Error code from server
  final String? errorCode;

  /// Server error type
  final String? errorType;

  /// Server stack trace if available
  final String? stackTrace;

  const ServerError(
    super.message, {
    this.errorCode,
    this.errorType,
    this.stackTrace,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('ServerError: $message');
    if (errorCode != null) {
      buffer.write(' (code: $errorCode)');
    }
    if (errorType != null) {
      buffer.write(' (type: $errorType)');
    }
    if (stackTrace != null) {
      buffer.write('\nStack trace: $stackTrace');
    }
    return buffer.toString();
  }
}

// Maintain backward compatibility with existing exception types
@Deprecated('Use TransportError instead')
typedef AgUiHttpException = TransportError;

@Deprecated('Use TransportError instead')
typedef AgUiConnectionException = TransportError;

@Deprecated('Use TimeoutError instead')
typedef AgUiTimeoutException = TimeoutError;

@Deprecated('Use ValidationError instead')
typedef AgUiValidationException = ValidationError;

@Deprecated('Use AgUiError instead')
typedef AgUiClientException = AgUiError;