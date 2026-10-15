import '../../client/ids.dart';

/// The retired reasoning shapes, translated to their 1.0 equivalents.
const thinkingStart = 'THINKING_START';
const thinkingEnd = 'THINKING_END';
const thinkingTextMessageStart = 'THINKING_TEXT_MESSAGE_START';
const thinkingTextMessageContent = 'THINKING_TEXT_MESSAGE_CONTENT';
const thinkingTextMessageEnd = 'THINKING_TEXT_MESSAGE_END';

/// The THINKING_* -> REASONING_* state machine, shared by the always-on
/// compatibility boundary and the version-gated 0.0.45 shim. The two differ
/// only in what they say about it, so each supplies its own notices.
final class ThinkingTranslator {
  ThinkingTranslator({required this.onTranslate, this.onAside});

  /// Announces one translated event, by retired and modern type.
  final void Function(String from, String to) onTranslate;

  /// A conversion side effect the caller has to be told about in its own
  /// sentence: something lost, or something invented. Null means silence.
  final void Function(String sentence)? onAside;

  String? _currentReasoningId;
  String? _currentMessageId;

  /// Forgets the ids in flight; a stream may carry several runs.
  void reset() {
    _currentReasoningId = null;
    _currentMessageId = null;
  }

  /// A THINKING_* continuation names nothing: the id it belongs to lives in
  /// this translator's state, put there by the matching opener. When no
  /// opener preceded it, one is MINTED, and announced, because verification
  /// will reject the translated event for naming something nothing opened.
  String _mintedContinuationId(String from, String? established) {
    if (established != null) return established;
    final minted = uuidV4();
    onAside?.call(
      "Minting a messageId ('$minted') for $from: no THINKING opener preceded "
      'it, so there was no id to continue. The id is this client\'s '
      "invention, not the producer's, and verification will reject the "
      'translated event for naming something nothing opened.',
    );
    return minted;
  }

  /// Translates a THINKING_* event; any other event is returned as is.
  Map<String, Object?> translate(Map<String, Object?> event) {
    switch (event['type']) {
      case thinkingStart:
        _currentReasoningId = uuidV4();
        onTranslate(thinkingStart, 'REASONING_START');
        final title = event['title'];
        if (title != null) {
          // REASONING_START has no `title`, so the span's label is dropped
          // here and nothing downstream can recover it: a LOSS, not a
          // translation, and the versioning rules require a lossy downgrade
          // to say what went.
          onAside?.call(
            'Dropping $thinkingStart.title "$title": REASONING_START has no '
            "title field, so the span's label cannot be carried and nothing "
            'downstream can recover it.',
          );
        }
        return Map<String, Object?>.from(event)
          ..remove('title')
          ..['type'] = 'REASONING_START'
          ..['messageId'] = _currentReasoningId;
      case thinkingTextMessageStart:
        _currentMessageId = uuidV4();
        onTranslate(thinkingTextMessageStart, 'REASONING_MESSAGE_START');
        return Map<String, Object?>.from(event)
          ..['type'] = 'REASONING_MESSAGE_START'
          ..['messageId'] = _currentMessageId
          // The schema pins this role to "reasoning"; the translation used to
          // say "assistant", which enforcement now rejects fatally.
          ..['role'] = 'reasoning';
      case thinkingTextMessageContent:
        onTranslate(thinkingTextMessageContent, 'REASONING_MESSAGE_CONTENT');
        return Map<String, Object?>.from(event)
          ..['type'] = 'REASONING_MESSAGE_CONTENT'
          ..['messageId'] = _mintedContinuationId(
            thinkingTextMessageContent,
            _currentMessageId,
          );
      case thinkingTextMessageEnd:
        final messageId = _mintedContinuationId(
          thinkingTextMessageEnd,
          _currentMessageId,
        );
        _currentMessageId = null;
        onTranslate(thinkingTextMessageEnd, 'REASONING_MESSAGE_END');
        return Map<String, Object?>.from(event)
          ..['type'] = 'REASONING_MESSAGE_END'
          ..['messageId'] = messageId;
      case thinkingEnd:
        final reasoningId = _mintedContinuationId(
          thinkingEnd,
          _currentReasoningId,
        );
        _currentReasoningId = null;
        onTranslate(thinkingEnd, 'REASONING_END');
        return Map<String, Object?>.from(event)
          ..['type'] = 'REASONING_END'
          ..['messageId'] = reasoningId;
      default:
        return event;
    }
  }
}
