/// Base types for AG-UI protocol models.
library;

import 'dart:convert';

/// Base class for all AG-UI models with JSON serialization support.
abstract class AGUIModel {
  const AGUIModel();

  /// Converts this model to a JSON map.
  Map<String, dynamic> toJson();

  /// Converts this model to a JSON string.
  String toJsonString() => json.encode(toJson());

  /// Creates a copy of this model with optional field updates.
  /// Subclasses should override this with their specific type.
  AGUIModel copyWith();
}

/// Mixin for models with type discriminators.
mixin TypeDiscriminator {
  /// The type discriminator field value.
  String get type;
}

/// Represents a validation error during JSON decoding.
class AGUIValidationError implements Exception {
  final String message;
  final String? field;
  final dynamic value;
  final Map<String, dynamic>? json;

  const AGUIValidationError({
    required this.message,
    this.field,
    this.value,
    this.json,
  });

  @override
  String toString() {
    final buffer = StringBuffer('AGUIValidationError: $message');
    if (field != null) buffer.write(' (field: $field)');
    if (value != null) buffer.write(' (value: $value)');
    return buffer.toString();
  }
}

/// Base exception for AG-UI protocol errors.
class AGUIError implements Exception {
  final String message;

  const AGUIError(this.message);

  @override
  String toString() => 'AGUIError: $message';
}

/// Utility for tolerant JSON decoding that ignores unknown fields.
class JsonDecoder {
  /// Safely extracts a required field from JSON.
  static T requireField<T>(
    Map<String, dynamic> json,
    String field, {
    T Function(dynamic)? transform,
  }) {
    if (!json.containsKey(field)) {
      throw AGUIValidationError(
        message: 'Missing required field',
        field: field,
        json: json,
      );
    }

    final value = json[field];
    if (value == null) {
      throw AGUIValidationError(
        message: 'Required field is null',
        field: field,
        value: value,
        json: json,
      );
    }

    if (transform != null) {
      try {
        return transform(value);
      } catch (e) {
        throw AGUIValidationError(
          message: 'Failed to transform field: $e',
          field: field,
          value: value,
          json: json,
        );
      }
    }

    if (value is! T) {
      throw AGUIValidationError(
        message: 'Field has incorrect type. Expected $T, got ${value.runtimeType}',
        field: field,
        value: value,
        json: json,
      );
    }

    return value;
  }

  /// Safely extracts an optional field from JSON.
  static T? optionalField<T>(
    Map<String, dynamic> json,
    String field, {
    T Function(dynamic)? transform,
  }) {
    if (!json.containsKey(field) || json[field] == null) {
      return null;
    }

    final value = json[field];
    
    if (transform != null) {
      try {
        return transform(value);
      } catch (e) {
        throw AGUIValidationError(
          message: 'Failed to transform field: $e',
          field: field,
          value: value,
          json: json,
        );
      }
    }

    if (value is! T) {
      throw AGUIValidationError(
        message: 'Field has incorrect type. Expected $T, got ${value.runtimeType}',
        field: field,
        value: value,
        json: json,
      );
    }

    return value;
  }

  /// Safely extracts a list field from JSON.
  static List<T> requireListField<T>(
    Map<String, dynamic> json,
    String field, {
    T Function(dynamic)? itemTransform,
  }) {
    final list = requireField<List<dynamic>>(json, field);
    
    if (itemTransform != null) {
      return list.map((item) {
        try {
          return itemTransform(item);
        } catch (e) {
          throw AGUIValidationError(
            message: 'Failed to transform list item: $e',
            field: field,
            value: item,
            json: json,
          );
        }
      }).toList();
    }

    return list.cast<T>();
  }

  /// Safely extracts an optional list field from JSON.
  static List<T>? optionalListField<T>(
    Map<String, dynamic> json,
    String field, {
    T Function(dynamic)? itemTransform,
  }) {
    final list = optionalField<List<dynamic>>(json, field);
    if (list == null) return null;
    
    if (itemTransform != null) {
      return list.map((item) {
        try {
          return itemTransform(item);
        } catch (e) {
          throw AGUIValidationError(
            message: 'Failed to transform list item: $e',
            field: field,
            value: item,
            json: json,
          );
        }
      }).toList();
    }

    return list.cast<T>();
  }
}

/// Converts snake_case to camelCase
String snakeToCamel(String snake) {
  final parts = snake.split('_');
  if (parts.isEmpty) return snake;
  
  return parts.first + 
    parts.skip(1).map((part) => 
      part.isEmpty ? '' : part[0].toUpperCase() + part.substring(1)
    ).join();
}

/// Converts camelCase to snake_case
String camelToSnake(String camel) {
  return camel.replaceAllMapped(
    RegExp(r'[A-Z]'),
    (match) => '_${match.group(0)!.toLowerCase()}',
  ).replaceFirst(RegExp(r'^_'), '');
}