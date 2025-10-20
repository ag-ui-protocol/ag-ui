import 'errors.dart';

/// Validation utilities for AG-UI SDK
class Validators {
  /// Validates that a string is not empty
  static void requireNonEmpty(String? value, String fieldName) {
    if (value == null || value.isEmpty) {
      throw ValidationError(
        'Field "$fieldName" cannot be empty',
        field: fieldName,
        constraint: 'non-empty',
        value: value,
      );
    }
  }

  /// Validates that a value is not null
  static T requireNonNull<T>(T? value, String fieldName) {
    if (value == null) {
      throw ValidationError(
        'Field "$fieldName" cannot be null',
        field: fieldName,
        constraint: 'non-null',
        value: value,
      );
    }
    return value;
  }

  /// Validates a URL format
  static void validateUrl(String? url, String fieldName) {
    requireNonEmpty(url, fieldName);
    
    try {
      final uri = Uri.parse(url!);
      if (!uri.hasScheme || !uri.hasAuthority) {
        throw ValidationError(
          'Invalid URL format for "$fieldName"',
          field: fieldName,
          constraint: 'valid-url',
          value: url,
        );
      }
      if (uri.scheme != 'http' && uri.scheme != 'https') {
        throw ValidationError(
          'URL scheme must be http or https for "$fieldName"',
          field: fieldName,
          constraint: 'http-or-https',
          value: url,
        );
      }
    } catch (e) {
      if (e is ValidationError) rethrow;
      throw ValidationError(
        'Invalid URL format for "$fieldName"',
        field: fieldName,
        constraint: 'valid-url',
        value: url,
        cause: e,
      );
    }
  }

  /// Validates an agent ID format
  static void validateAgentId(String? agentId) {
    requireNonEmpty(agentId, 'agentId');
    
    // Agent IDs should be alphanumeric with optional hyphens and underscores
    final pattern = RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$');
    if (!pattern.hasMatch(agentId!)) {
      throw ValidationError(
        'Invalid agent ID format',
        field: 'agentId',
        constraint: 'alphanumeric-with-hyphens-underscores',
        value: agentId,
      );
    }
    
    if (agentId.length > 100) {
      throw ValidationError(
        'Agent ID too long (max 100 characters)',
        field: 'agentId',
        constraint: 'max-length-100',
        value: agentId,
      );
    }
  }

  /// Validates a run ID format
  static void validateRunId(String? runId) {
    requireNonEmpty(runId, 'runId');
    
    // Run IDs are typically UUIDs or similar identifiers
    if (runId!.length > 100) {
      throw ValidationError(
        'Run ID too long (max 100 characters)',
        field: 'runId',
        constraint: 'max-length-100',
        value: runId,
      );
    }
  }

  /// Validates a thread ID format
  static void validateThreadId(String? threadId) {
    requireNonEmpty(threadId, 'threadId');
    
    if (threadId!.length > 100) {
      throw ValidationError(
        'Thread ID too long (max 100 characters)',
        field: 'threadId',
        constraint: 'max-length-100',
        value: threadId,
      );
    }
  }

  /// Validates message content
  static void validateMessageContent(dynamic content) {
    if (content == null) {
      throw ValidationError(
        'Message content cannot be null',
        field: 'content',
        constraint: 'non-null',
        value: content,
      );
    }
    
    // Content should be either a string or a structured object
    if (content is! String && content is! Map && content is! List) {
      throw ValidationError(
        'Message content must be a string, map, or list',
        field: 'content',
        constraint: 'valid-type',
        value: content,
      );
    }
  }

  /// Validates timeout duration
  static void validateTimeout(Duration? timeout) {
    if (timeout == null) return;
    
    if (timeout.isNegative) {
      throw ValidationError(
        'Timeout cannot be negative',
        field: 'timeout',
        constraint: 'non-negative',
        value: timeout.toString(),
      );
    }
    
    // Max timeout of 10 minutes
    const maxTimeout = Duration(minutes: 10);
    if (timeout > maxTimeout) {
      throw ValidationError(
        'Timeout exceeds maximum of 10 minutes',
        field: 'timeout',
        constraint: 'max-10-minutes',
        value: timeout.toString(),
      );
    }
  }

  /// Validates a map contains required fields
  static void requireFields(Map<String, dynamic> map, List<String> requiredFields) {
    for (final field in requiredFields) {
      if (!map.containsKey(field)) {
        throw ValidationError(
          'Missing required field "$field"',
          field: field,
          constraint: 'required',
          value: map,
        );
      }
    }
  }

  /// Validates JSON data structure
  static Map<String, dynamic> validateJson(dynamic json, String context) {
    if (json == null) {
      throw DecodingError(
        'JSON cannot be null in $context',
        field: context,
        expectedType: 'Map<String, dynamic>',
        actualValue: json,
      );
    }
    
    if (json is! Map<String, dynamic>) {
      throw DecodingError(
        'Expected JSON object in $context',
        field: context,
        expectedType: 'Map<String, dynamic>',
        actualValue: json,
      );
    }
    
    return json;
  }

  /// Validates event type
  static void validateEventType(String? eventType) {
    requireNonEmpty(eventType, 'eventType');
    
    // Event types should follow the naming convention
    final pattern = RegExp(r'^[A-Z][A-Z_]*$');
    if (!pattern.hasMatch(eventType!)) {
      throw ValidationError(
        'Invalid event type format (should be UPPER_SNAKE_CASE)',
        field: 'eventType',
        constraint: 'upper-snake-case',
        value: eventType,
      );
    }
  }

  /// Validates HTTP status code
  static void validateStatusCode(int? statusCode, String endpoint, [String? responseBody]) {
    if (statusCode == null) return;
    
    if (statusCode < 200 || statusCode >= 300) {
      String message;
      if (statusCode >= 400 && statusCode < 500) {
        message = 'Client error';
      } else if (statusCode >= 500) {
        message = 'Server error';
      } else {
        message = 'Unexpected status';
      }
      
      throw TransportError(
        '$message at $endpoint',
        statusCode: statusCode,
        endpoint: endpoint,
        responseBody: responseBody,
      );
    }
  }

  /// Validates SSE event data
  static void validateSseEvent(Map<String, String>? event) {
    if (event == null || event.isEmpty) {
      throw DecodingError(
        'SSE event cannot be empty',
        field: 'event',
        expectedType: 'Map<String, String>',
        actualValue: event,
      );
    }
    
    if (!event.containsKey('data')) {
      throw DecodingError(
        'SSE event missing required "data" field',
        field: 'data',
        expectedType: 'String',
        actualValue: event,
      );
    }
  }

  /// Validates protocol compliance for event sequences
  static void validateEventSequence(String currentEvent, String? previousEvent, String? state) {
    // RUN_STARTED must be first or after RUN_FINISHED
    if (currentEvent == 'RUN_STARTED') {
      if (previousEvent != null && previousEvent != 'RUN_FINISHED') {
        throw ProtocolViolationError(
          'RUN_STARTED can only occur at the beginning or after RUN_FINISHED',
          rule: 'run-lifecycle',
          state: state,
          expected: 'No previous event or RUN_FINISHED',
        );
      }
    }
    
    // RUN_FINISHED must have a preceding RUN_STARTED
    if (currentEvent == 'RUN_FINISHED' && state != 'running') {
      throw ProtocolViolationError(
        'RUN_FINISHED without preceding RUN_STARTED',
        rule: 'run-lifecycle',
        state: state,
        expected: 'RUN_STARTED before RUN_FINISHED',
      );
    }
    
    // Tool call events must be within a run
    if (currentEvent.startsWith('TOOL_CALL_') && state != 'running') {
      throw ProtocolViolationError(
        'Tool call events must occur within a run',
        rule: 'tool-call-lifecycle',
        state: state,
        expected: 'State should be "running"',
      );
    }
  }

  /// Validates model output format
  static T validateModel<T>(
    dynamic data,
    String modelName,
    T Function(Map<String, dynamic>) fromJson,
  ) {
    final json = validateJson(data, modelName);
    
    try {
      return fromJson(json);
    } catch (e) {
      throw DecodingError(
        'Failed to decode $modelName',
        field: modelName,
        expectedType: modelName,
        actualValue: json,
        cause: e,
      );
    }
  }

  /// Validates list of models
  static List<T> validateModelList<T>(
    dynamic data,
    String modelName,
    T Function(Map<String, dynamic>) fromJson,
  ) {
    if (data == null) {
      throw DecodingError(
        'List cannot be null for $modelName',
        field: modelName,
        expectedType: 'List',
        actualValue: data,
      );
    }
    
    if (data is! List) {
      throw DecodingError(
        'Expected list for $modelName',
        field: modelName,
        expectedType: 'List',
        actualValue: data,
      );
    }
    
    final results = <T>[];
    for (var i = 0; i < data.length; i++) {
      try {
        final item = validateModel(data[i], '$modelName[$i]', fromJson);
        results.add(item);
      } catch (e) {
        throw DecodingError(
          'Failed to decode item $i in $modelName list',
          field: '$modelName[$i]',
          expectedType: modelName,
          actualValue: data[i],
          cause: e,
        );
      }
    }
    
    return results;
  }
}