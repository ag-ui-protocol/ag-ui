import '../../client/warnings.dart';
import 'legacy_content.dart';
import 'optional_nulls.dart';
import 'thinking.dart';

/// The compatibility boundary's conversion notice.
String compatibilityNotice(String what, String replacement) =>
    '[ag-ui][compat] Converting deprecated $what to $replacement. The old '
    'shape leaves the protocol after its shim window — see the repo-root '
    'DEPRECATIONS.md. Set SUPPRESS_TRANSFORMATION_WARNINGS=true to silence.';

/// The always-on pre-1.0 compatibility boundary.
///
/// With enforcement running after it, anything nobody translates is stripped
/// with a warning. This is the translator: it upgrades every retired but
/// understood inbound shape into its 1.0 equivalent, so no data an old peer
/// sends is lost. It is deliberately NOT version-gated — a legacy-shaped
/// event arriving is itself the proof the peer is old, and on a modern stream
/// every branch is a no-op.
///
/// Inbound conversions, each warned with a pointer to DEPRECATIONS.md:
/// - THINKING_* events -> their REASONING_* equivalents.
/// - Legacy binary content parts inside inbound messages (MESSAGES_SNAPSHOT,
///   RUN_STARTED input) -> the modern media parts.
/// - The whole optional nulls listed in [optionalNulls] -> absent, on the
///   event itself, in RUN_FINISHED's outcome and usage entries, and inside
///   RUN_STARTED.input and inbound messages.
///
/// The THINKING_* and binary conversions warn once per occurrence. An
/// optional null warns once per field and location per run.
final class CompatibilityBoundary {
  CompatibilityBoundary(this.warn)
    : _thinking = ThinkingTranslator(
        onTranslate: (from, to) => warn(compatibilityNotice(from, to)),
        onAside:
            (sentence) => warn(
              '[ag-ui][compat] $sentence Set SUPPRESS_TRANSFORMATION_WARNINGS=true '
              'to silence.',
            ),
      );

  final WarningSink warn;
  final ThinkingTranslator _thinking;
  final Set<String> _nullsNoticedThisRun = {};

  void _noticeNullOncePerRun(String what) {
    if (!_nullsNoticedThisRun.add(what)) return;
    warn(compatibilityNotice(what, 'an absent field'));
  }

  /// The boundary as a stream stage, with fresh state per subscription.
  Stream<Map<String, Object?>> call(
    Stream<Map<String, Object?>> source,
  ) async* {
    _thinking.reset();
    _nullsNoticedThisRun.clear();
    await for (final event in source) {
      yield transformEvent(event);
    }
  }

  /// Translates one raw event.
  Map<String, Object?> transformEvent(Map<String, Object?> event) {
    final notice = _noticeNullOncePerRun;
    // A stream may carry several sequential runs; each one warns afresh.
    if (event['type'] == 'RUN_STARTED') _nullsNoticedThisRun.clear();
    // Whole optional nulls first, so the translations below and combined old
    // shapes (e.g. result:null plus outcome:null) see the normalised event.
    var current =
        omitTabledNulls(event, optionalNulls['event']!, null, notice)!
            as Map<String, Object?>;
    final type = current['type'];
    final typeFields = type is String ? optionalNulls[type] : null;
    if (typeFields != null) {
      current =
          omitTabledNulls(current, typeFields, type! as String, notice)!
              as Map<String, Object?>;
    }
    switch (type) {
      case thinkingStart ||
          thinkingTextMessageStart ||
          thinkingTextMessageContent ||
          thinkingTextMessageEnd ||
          thinkingEnd:
        return _thinking.translate(current);
      case 'RUN_FINISHED':
        final outcome = omitTabledNulls(
          current['outcome'],
          optionalNulls['RUN_FINISHED.outcome']!,
          'RUN_FINISHED.outcome',
          notice,
        );
        final normalized =
            identical(outcome, current['outcome'])
                ? current
                : (Map<String, Object?>.from(current)..['outcome'] = outcome);
        return mapProtocolArray(
              normalized,
              'usage',
              (entry) => omitTabledNulls(
                entry,
                optionalNulls['RUN_FINISHED.usage[]']!,
                'RUN_FINISHED.usage[]',
                notice,
              ),
            )!
            as Map<String, Object?>;
      case 'MESSAGES_SNAPSHOT':
        final messages = current['messages'];
        if (messages is! List) return current;
        return Map<String, Object?>.from(current)
          ..['messages'] = [
            for (final message in messages) upgradeInboundMessage(message),
          ];
      case 'RUN_STARTED':
        final normalizedInput = normalizeLegacyRunAgentInput(
          current['input'],
          notice,
        );
        final normalized =
            identical(normalizedInput, current['input'])
                ? current
                : (Map<String, Object?>.from(current)
                  ..['input'] = normalizedInput);
        final input = normalized['input'];
        if (input is! Map) return normalized;
        final messages = input['messages'];
        if (messages is! List) return normalized;
        return Map<String, Object?>.from(normalized)
          ..['input'] = (Map<String, Object?>.from(input)
            ..['messages'] = [
              for (final message in messages) upgradeInboundMessage(message),
            ]);
      default:
        return current;
    }
  }

  /// Upgrades one inbound message: media-part metadata nulls read as absent,
  /// and legacy binary parts become modern media parts.
  Object? upgradeInboundMessage(Object? message) {
    final normalized = normalizeLegacyMessageNulls(
      message,
      _noticeNullOncePerRun,
    );
    if (normalized is! Map) return normalized;
    final content = normalized['content'];
    if (content is! List || !content.any(isLegacyBinaryContent)) {
      return normalized;
    }
    warn(
      compatibilityNotice(
        'binary input content',
        'the modern media content parts',
      ),
    );
    return upgradeMessageContent(normalized.cast<String, Object?>(), warn);
  }
}
