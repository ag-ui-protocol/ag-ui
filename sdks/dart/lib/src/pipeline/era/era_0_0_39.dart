import '../../client/warnings.dart';
import '../../generated/models.dart';

/// The 0.0.39 downgrade, outgoing only: a peer that old cannot receive
/// message content as a list of parts, so a user message's parts are
/// flattened to their text, and `parentRunId` is dropped from the request.
///
/// Works on the request's wire form rather than the typed input, exactly as
/// the TypeScript middleware works on its loosely typed input, so the two
/// agree branch for branch: text parts are joined, non-text parts are
/// dropped with a warning, a malformed text part leaves the message untouched
/// (a downgrade must not repair a defect), absent content becomes the empty
/// string the older schema requires, and any other content is left for the
/// decoder to reject.
RunAgentInput flattenContentFor0039(RunAgentInput input, WarningSink warn) {
  final json = input.toJson()..remove('parentRunId');
  final messages = json['messages'] as List;
  json['messages'] = [
    for (final message in messages)
      sanitizeMessageContent((message as Map).cast<String, Object?>(), warn),
  ];
  return RunAgentInput.fromJson(json);
}

/// One message's content, flattened for a <=0.0.39 peer. Exposed for tests.
Map<String, Object?> sanitizeMessageContent(
  Map<String, Object?> message,
  WarningSink warn,
) {
  final content = message['content'];
  if (content is List) {
    bool isTextPart(Object? part) => part is Map && part['type'] == 'text';
    bool isText(Object? part) =>
        isTextPart(part) && (part as Map)['text'] is String;

    // "A downgrade MUST NOT repair a malformed value on the way past": a
    // malformed text part is a defect in the message, handed on untouched so
    // the outgoing boundary reports it, the same as when no shim is installed.
    final malformed = content.where(
      (part) => isTextPart(part) && !isText(part),
    );
    if (malformed.isNotEmpty) {
      warn(
        '[ag-ui][compat] Not flattening message content for a <=0.0.39 peer: '
        '${malformed.length} content part(s) claim type "text" but carry a '
        "malformed 'text' value. That is a defect in the message, not media "
        'the peer cannot represent, and a downgrade must not repair it — the '
        'content is passed on unchanged so the outgoing enforcement boundary '
        'reports it. See the repo-root DEPRECATIONS.md.',
      );
      return message;
    }

    // Losing content must never be silent.
    final dropped = [
      for (final part in content)
        if (!isText(part))
          part is Map ? '${part['type']}' : part.runtimeType.toString(),
    ];
    if (dropped.isNotEmpty) {
      warn(
        '[ag-ui][compat] Flattening message content for a <=0.0.39 peer DROPS '
        'non-text parts (${dropped.join(', ')}). The peer cannot receive them; '
        'upgrade it to keep media content. See the repo-root DEPRECATIONS.md.',
      );
    }

    final text =
        [
          for (final part in content)
            if (isText(part)) (part as Map)['text'] as String,
        ].join();
    return Map<String, Object?>.from(message)..['content'] = text;
  }
  if (content is String) return message;
  // Absent content is the one value a downgrade may supply for: the older
  // schema requires the field.
  if (!message.containsKey('content')) {
    return Map<String, Object?>.from(message)..['content'] = '';
  }
  // Anything else is a known field holding a value the schema rejects;
  // untouched, so the boundary reports it.
  return message;
}
