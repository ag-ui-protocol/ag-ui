/// Stream adapter for converting SSE messages to typed AG-UI events.
library;

import 'dart:async';

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
    if (jsonData is Map<String, dynamic>) {
      // Single event
      return [_decoder.decodeJson(jsonData)];
    } else if (jsonData is List) {
      // Array of events
      return jsonData
          .whereType<Map<String, dynamic>>()
          .map((json) => _decoder.decodeJson(json))
          .toList();
    } else {
      // Invalid data
      return [];
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
              final event = _decoder.decode(data);
              sink.add(event);
            }
            // Ignore non-data messages (id, event, retry, comments)
          } catch (e, stack) {
            if (skipInvalidEvents) {
              // Log error but continue processing
              onError?.call(e, stack);
            } else {
              // Propagate error to stream
              sink.addError(e, stack);
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
    final controller = StreamController<BaseEvent>();
    
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
        // Process any remaining buffered data
        final remaining = _buffer.toString();
        if (remaining.isNotEmpty && _inDataBlock) {
          try {
            final event = _decoder.decode(remaining);
            controller.add(event);
          } catch (e, stack) {
            if (!skipInvalidEvents) {
              controller.addError(e, stack);
            } else {
              onError?.call(e, stack);
            }
          }
        }
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
    final lines = chunk.split('\n');
    
    for (final line in lines) {
      if (line.startsWith('data: ')) {
        final data = line.substring(6);
        if (_inDataBlock) {
          // Continue accumulating multi-line data
          _buffer.writeln(data);
        } else {
          // Start new data block
          _buffer.clear();
          _buffer.write(data);
          _inDataBlock = true;
        }
      } else if (line.startsWith('data:')) {
        final data = line.substring(5);
        if (_inDataBlock) {
          _buffer.writeln(data);
        } else {
          _buffer.clear();
          _buffer.write(data);
          _inDataBlock = true;
        }
      } else if (line.isEmpty && _inDataBlock) {
        // Empty line signals end of SSE message
        final data = _buffer.toString();
        _buffer.clear();
        _inDataBlock = false;
        
        if (data.isNotEmpty) {
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
    final controller = StreamController<List<BaseEvent>>();
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