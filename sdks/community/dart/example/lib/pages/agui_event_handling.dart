import 'package:flutter/foundation.dart';
import 'package:ag_ui/ag_ui.dart';
import '../models/chat_message.dart';
import '../services/ids.dart';

/// Shared AG-UI event handling for the dojo page state classes.
///
/// Centralizes the cross-cutting behaviors that every page needs and that are NOT
/// inherited from `ChatPageState`:
///  - text-message streaming (start/content/end/chunk),
///  - reasoning passthrough (the current AG-UI path; the deprecated THINKING_* events
///    are not handled — the dojo server emits REASONING_*),
///  - `RUN_ERROR` (which arrives as a [RunErrorEvent] *through the stream*, not a throw).
///
/// Host classes mix this in (`with AgUiEventHandling`), maintain [messages], set
/// [disposed] in their `dispose()`, and call [handleCommonEvent] from their own
/// `_handleEvent`; if it returns true the event was consumed. Override [onRunReset] to
/// clear host-specific busy/loading flags when a run errors.
mixin AgUiEventHandling on ChangeNotifier {
  /// Set true in the host's `dispose()` BEFORE `super.dispose()`.
  bool disposed = false;

  /// The display message list rendered by the page.
  final List<ChatMessage> messages = [];

  ChatMessage? _streaming;

  /// Hook for the host to reset its own state (e.g. `_busy`, `_loading`) on RUN_ERROR.
  void onRunReset() {}

  /// Returns true if [event] was one of the common types and has been handled.
  bool handleCommonEvent(BaseEvent event) {
    if (event is TextMessageStartEvent) {
      _streaming = ChatMessage(
        id: event.messageId,
        type: ChatMessageType.assistant,
        content: '',
        timestamp: DateTime.now(),
        isStreaming: true,
      );
      messages.add(_streaming!);
      return true;
    }
    if (event is TextMessageContentEvent) {
      _appendStreaming(event.delta);
      return true;
    }
    if (event is TextMessageChunkEvent) {
      if (_streaming == null) {
        _streaming = ChatMessage(
          id: event.messageId ?? uid('assistant'),
          type: ChatMessageType.assistant,
          content: event.delta ?? '',
          timestamp: DateTime.now(),
          isStreaming: true,
        );
        messages.add(_streaming!);
      } else {
        _appendStreaming(event.delta ?? '');
      }
      return true;
    }
    if (event is TextMessageEndEvent) {
      _endStreaming();
      return true;
    }
    if (event is ReasoningStartEvent) {
      messages.add(ChatMessage(
        id: uid('reasoning'),
        type: ChatMessageType.reasoning,
        content: '',
        timestamp: DateTime.now(),
        isStreaming: true,
      ));
      return true;
    }
    if (event is ReasoningMessageContentEvent) {
      _appendStreamingOfType(ChatMessageType.reasoning, event.delta);
      return true;
    }
    if (event is ReasoningEndEvent) {
      _endStreamingOfType(ChatMessageType.reasoning);
      return true;
    }
    if (event is RunErrorEvent) {
      messages.add(ChatMessage(
        id: uid('error'),
        type: ChatMessageType.system,
        content: '⚠️ Run error: ${event.message}',
        timestamp: DateTime.now(),
      ));
      onRunReset();
      return true;
    }
    return false;
  }

  /// Append a reasoning message extracted from a MESSAGES_SNAPSHOT (host calls this).
  void addReasoningMessage(String text) {
    if (text.isEmpty) return;
    messages.add(ChatMessage(
      id: uid('reasoning'),
      type: ChatMessageType.reasoning,
      content: text,
      timestamp: DateTime.now(),
    ));
  }

  void _appendStreaming(String delta) {
    final s = _streaming;
    if (s == null) return;
    final i = messages.indexOf(s);
    if (i == -1) return;
    _streaming = s.copyWith(content: s.content + delta);
    messages[i] = _streaming!;
  }

  void _endStreaming() {
    final s = _streaming;
    if (s == null) return;
    final i = messages.indexOf(s);
    if (i != -1) messages[i] = s.copyWith(isStreaming: false);
    _streaming = null;
  }

  void _appendStreamingOfType(ChatMessageType type, String delta) {
    final matches = messages.where((m) => m.type == type && m.isStreaming);
    if (matches.isEmpty) return;
    final last = matches.last;
    final i = messages.indexOf(last);
    if (i != -1) messages[i] = last.copyWith(content: last.content + delta);
  }

  void _endStreamingOfType(ChatMessageType type) {
    final matches = messages.where((m) => m.type == type && m.isStreaming);
    if (matches.isEmpty) return;
    final last = matches.last;
    final i = messages.indexOf(last);
    if (i != -1) messages[i] = last.copyWith(isStreaming: false);
  }
}
