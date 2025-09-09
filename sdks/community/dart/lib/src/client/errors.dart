/// Base exception for AG-UI client errors
class AgUiClientException implements Exception {
  final String message;
  final dynamic cause;

  const AgUiClientException(this.message, [this.cause]);

  @override
  String toString() {
    if (cause != null) {
      return 'AgUiClientException: $message\nCause: $cause';
    }
    return 'AgUiClientException: $message';
  }
}

/// HTTP request/response errors
class AgUiHttpException extends AgUiClientException {
  final String endpoint;
  final int? statusCode;
  final String? responseBody;

  const AgUiHttpException(
    String message, {
    required this.endpoint,
    this.statusCode,
    this.responseBody,
    dynamic cause,
  }) : super(message, cause);

  @override
  String toString() {
    final buffer = StringBuffer('AgUiHttpException: $message');
    buffer.writeln('\nEndpoint: $endpoint');
    if (statusCode != null) {
      buffer.writeln('Status Code: $statusCode');
    }
    if (responseBody != null && responseBody!.isNotEmpty) {
      final excerpt = responseBody!.length > 200
          ? '${responseBody!.substring(0, 200)}...'
          : responseBody!;
      buffer.writeln('Response: $excerpt');
    }
    if (cause != null) {
      buffer.writeln('Cause: $cause');
    }
    return buffer.toString();
  }
}

/// Connection errors
class AgUiConnectionException extends AgUiClientException {
  const AgUiConnectionException(super.message, [super.cause]);
}

/// Timeout errors
class AgUiTimeoutException extends AgUiClientException {
  final Duration timeout;

  const AgUiTimeoutException(String message, {required this.timeout, dynamic cause})
      : super(message, cause);

  @override
  String toString() {
    return 'AgUiTimeoutException: $message (timeout: ${timeout.inSeconds}s)';
  }
}

/// Validation errors
class AgUiValidationException extends AgUiClientException {
  final String field;

  const AgUiValidationException(String message, {required this.field, dynamic cause})
      : super(message, cause);

  @override
  String toString() {
    return 'AgUiValidationException: $message (field: $field)';
  }
}