/// Stream adapter for converting SSE messages to typed AG-UI events.
library;

import 'dart:async';

import '../client/errors.dart';
import '../client/validators.dart';
import '../events/events.dart';
import '../sse/sse_message.dart';
import 'decoder.dart';

/// Adapter for converting streams of SSE messages to typed AG-UI events.
///
/// This class provides utilities to:
/// - Convert SSE message streams to typed event streams
/// - Handle partial messages and buffering
/// - Filter and transform events
/// - Handle errors gracefully
class EventStreamAdapter {
  final EventDecoder _decoder;
  
  /// Buffer for accumulating partial SSE data.
  final StringBuffer _buffer = StringBuffer();
  
  /// Buffer for accumulating data field values (without "data: " prefix).
  final StringBuffer _dataBuffer = StringBuffer();
  
  /// Whether we're currently in a multi-line data block.
  bool _inDataBlock = false;

  /// Creates a new stream adapter with an optional custom decoder.
  EventStreamAdapter({EventDecoder? decoder})
      : _decoder = decoder ?? const EventDecoder();
  
  /// Adapts JSON data to AG-UI events.
  ///
  /// Returns a list of events parsed from the JSON data.
  /// If the JSON is a single event, returns a list with one event.
  /// If the JSON is an array of events, returns all events.
  List<BaseEvent> adaptJsonToEvents(dynamic jsonData) {
    try {
      if (jsonData is Map<String, dynamic>) {
        // Single event
        return [_decoder.decodeJson(jsonData)];
      } else if (jsonData is List) {
        // Array of events
        final events = <BaseEvent>[];
        for (var i = 0; i < jsonData.length; i++) {
          if (jsonData[i] is Map<String, dynamic>) {
            try {
              events.add(_decoder.decodeJson(jsonData[i] as Map<String, dynamic>));
            } catch (e) {
              throw DecodingError(
                'Failed to decode event at index $i',
                field: 'jsonData[$i]',
                expectedType: 'BaseEvent',
                actualValue: jsonData[i],
                cause: e,
              );
            }
          }
        }
        return events;
      } else {
        throw DecodingError(
          'Invalid JSON data type',
          field: 'jsonData',
          expectedType: 'Map<String, dynamic> or List',
          actualValue: jsonData,
        );
      }
    } on AgUiError {
      rethrow;
    } catch (e) {
      throw DecodingError(
        'Failed to adapt JSON to events',
        field: 'jsonData',
        expectedType: 'BaseEvent or List<BaseEvent>',
        actualValue: jsonData,
        cause: e,
      );
    }
  }

  /// Converts a stream of SSE messages to a stream of typed AG-UI events.
  ///
  /// This method handles:
  /// - Decoding SSE data fields to JSON
  /// - Parsing JSON to typed event objects
  /// - Filtering out non-data messages (comments, etc.)
  /// - Error handling with optional recovery
  Stream<BaseEvent> fromSseStream(
    Stream<SseMessage> sseStream, {
    bool skipInvalidEvents = false,
    void Function(Object error, StackTrace stackTrace)? onError,
  }) {
    return sseStream.transform(
      StreamTransformer<SseMessage, BaseEvent>.fromHandlers(
        handleData: (message, sink) {
          try {
            // Only process data messages
            final data = message.data;
            if (data != null && data.isNotEmpty) {
              // Skip keep-alive messages
              if (data.trim() == ':') {
                return;
              }
              
              final event = _decoder.decode(data);
              
              // Validate event before adding to stream
              if (_decoder.validate(event)) {
                sink.add(event);
              }
            }
            // Ignore non-data messages (id, event, retry, comments)
          } catch (e, stack) {
            final error = e is AgUiError ? e : DecodingError(
              'Failed to process SSE message',
              field: 'message',
              expectedType: 'BaseEvent',
              actualValue: message.data,
              cause: e,
            );
            
            if (skipInvalidEvents) {
              // Log error but continue processing
              onError?.call(error, stack);
            } else {
              // Propagate error to stream
              sink.addError(error, stack);
            }
          }
        },
        handleError: (error, stack, sink) {
          if (skipInvalidEvents) {
            // Log error but continue processing
            onError?.call(error, stack);
          } else {
            // Propagate error to stream
            sink.addError(error, stack);
          }
        },
      ),
    );
  }

  /// Converts a stream of raw SSE strings to typed AG-UI events.
  ///
  /// This handles partial messages that may be split across multiple
  /// stream events, buffering as needed.
  Stream<BaseEvent> fromRawSseStream(
    Stream<String> rawStream, {
    bool skipInvalidEvents = false,
    void Function(Object error, StackTrace stackTrace)? onError,
  }) {
    final controller = StreamController<BaseEvent>(sync: true);
    
    rawStream.listen(
      (chunk) {
        try {
          _processChunk(chunk, controller, skipInvalidEvents, onError);
        } catch (e, stack) {
          if (!skipInvalidEvents) {
            controller.addError(e, stack);
          } else {
            onError?.call(e, stack);
          }
        }
      },
      onError: (Object error, StackTrace stack) {
        if (!skipInvalidEvents) {
          controller.addError(error, stack);
        } else {
          onError?.call(error, stack);
        }
      },
      onDone: () {
        // Process any remaining incomplete line in buffer
        final remaining = _buffer.toString();
        if (remaining.isNotEmpty) {
          // Treat remaining content as a complete line
          if (remaining.startsWith('data: ')) {
            final value = remaining.substring(6);
            if (_inDataBlock) {
              _dataBuffer.write('\n');
              _dataBuffer.write(value);
            } else {
              _dataBuffer.clear();
              _dataBuffer.write(value);
              _inDataBlock = true;
            }
          } else if (remaining.startsWith('data:')) {
            final value = remaining.substring(5);
            if (_inDataBlock) {
              _dataBuffer.write('\n');
              _dataBuffer.write(value);
            } else {
              _dataBuffer.clear();
              _dataBuffer.write(value);
              _inDataBlock = true;
            }
          }
        }
        
        // Process any accumulated data
        if (_inDataBlock && _dataBuffer.isNotEmpty) {
          final data = _dataBuffer.toString();
          try {
            final event = _decoder.decode(data);
            controller.add(event);
          } catch (e, stack) {
            if (!skipInvalidEvents) {
              controller.addError(e, stack);
            } else {
              onError?.call(e, stack);
            }
          }
        }
        // Clear buffers
        _buffer.clear();
        _dataBuffer.clear();
        _inDataBlock = false;
        controller.close();
      },
      cancelOnError: false,
    );
    
    return controller.stream;
  }

  /// Process a chunk of SSE data.
  void _processChunk(
    String chunk,
    StreamController<BaseEvent> controller,
    bool skipInvalidEvents,
    void Function(Object error, StackTrace stackTrace)? onError,
  ) {
    // Add chunk to buffer to handle partial lines
    _buffer.write(chunk);
    
    // Process complete lines only
    String bufferStr = _buffer.toString();
    final lines = <String>[];
    
    // Extract complete lines (those ending with \n)
    while (bufferStr.contains('\n')) {
      final lineEnd = bufferStr.indexOf('\n');
      final line = bufferStr.substring(0, lineEnd);
      lines.add(line);
      bufferStr = bufferStr.substring(lineEnd + 1);
    }
    
    // Keep any incomplete line in the buffer
    _buffer.clear();
    _buffer.write(bufferStr);
    
    // Process each complete line
    for (final line in lines) {
      if (line.isEmpty) {
        // Empty line signals end of SSE message
        if (_inDataBlock) {
          final data = _dataBuffer.toString();
          _dataBuffer.clear();
          _inDataBlock = false;
          
          if (data.isNotEmpty && data.trim() != ':') {
            try {
              final event = _decoder.decode(data);
              if (_decoder.validate(event)) {
                controller.add(event);
              }
            } catch (e, stack) {
              final error = e is AgUiError ? e : DecodingError(
                'Failed to decode SSE data',
                field: 'data',
                expectedType: 'BaseEvent',
                actualValue: data,
                cause: e,
              );
              
              if (!skipInvalidEvents) {
                controller.addError(error, stack);
              } else {
                onError?.call(error, stack);
              }
            }
          }
        }
      } else if (line.startsWith('data: ')) {
        // Extract data value (after "data: ")
        final value = line.substring(6);
        if (_inDataBlock) {
          // Multi-line data: add newline between lines
          _dataBuffer.write('\n');
          _dataBuffer.write(value);
        } else {
          // Start new data block
          _dataBuffer.clear();
          _dataBuffer.write(value);
          _inDataBlock = true;
        }
      } else if (line.startsWith('data:')) {
        // Handle no space after colon
        final value = line.substring(5);
        if (_inDataBlock) {
          _dataBuffer.write('\n');
          _dataBuffer.write(value);
        } else {
          _dataBuffer.clear();
          _dataBuffer.write(value);
          _inDataBlock = true;
        }
      }
      // Ignore other lines (comments, event:, id:, retry:, etc.)
    }
  }

  /// Filters a stream of events to only include specific event types.
  static Stream<T> filterByType<T extends BaseEvent>(
    Stream<BaseEvent> eventStream,
  ) {
    return eventStream.where((event) => event is T).cast<T>();
  }

  /// Groups related events together.
  ///
  /// For example, groups TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT,
  /// and TEXT_MESSAGE_END events for the same messageId.
  static Stream<List<BaseEvent>> groupRelatedEvents(
    Stream<BaseEvent> eventStream,
  ) {
    final controller = StreamController<List<BaseEvent>>(sync: true);
    final Map<String, List<BaseEvent>> activeGroups = {};
    
    eventStream.listen(
      (event) {
        switch (event) {
          case TextMessageStartEvent(:final messageId):
            activeGroups[messageId] = [event];
          case TextMessageContentEvent(:final messageId):
            activeGroups[messageId]?.add(event);
          case TextMessageEndEvent(:final messageId):
            final group = activeGroups.remove(messageId);
            if (group != null) {
              group.add(event);
              controller.add(group);
            }
          case ToolCallStartEvent(:final toolCallId):
            activeGroups[toolCallId] = [event];
          case ToolCallArgsEvent(:final toolCallId):
            activeGroups[toolCallId]?.add(event);
          case ToolCallEndEvent(:final toolCallId):
            final group = activeGroups.remove(toolCallId);
            if (group != null) {
              group.add(event);
              controller.add(group);
            }
          default:
            // Single events not part of a group
            controller.add([event]);
        }
      },
      onError: controller.addError,
      onDone: () {
        // Emit any incomplete groups
        for (final group in activeGroups.values) {
          if (group.isNotEmpty) {
            controller.add(group);
          }
        }
        controller.close();
      },
      cancelOnError: false,
    );
    
    return controller.stream;
  }

  /// Accumulates text message content into complete messages.
  static Stream<String> accumulateTextMessages(
    Stream<BaseEvent> eventStream,
  ) {
    final controller = StreamController<String>();
    final Map<String, StringBuffer> activeMessages = {};
    
    eventStream.listen(
      (event) {
        switch (event) {
          case TextMessageStartEvent(:final messageId):
            activeMessages[messageId] = StringBuffer();
          case TextMessageContentEvent(:final messageId, :final delta):
            activeMessages[messageId]?.write(delta);
          case TextMessageEndEvent(:final messageId):
            final buffer = activeMessages.remove(messageId);
            if (buffer != null) {
              controller.add(buffer.toString());
            }
          case TextMessageChunkEvent(:final messageId, :final delta):
            // Handle chunk events (single event with complete content)
            if (messageId != null && delta != null) {
              controller.add(delta);
            }
          default:
            // Ignore other event types
            break;
        }
      },
      onError: controller.addError,
      onDone: controller.close,
      cancelOnError: false,
    );
    
    return controller.stream;
  }
}