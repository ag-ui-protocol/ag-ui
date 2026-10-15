/// Announces one converted null; `what` names the field and where it sat.
typedef NullNotice = void Function(String what);

/// Every whole optional field the client reads as absent when a producer
/// sends it as `null`, by where the field sits. This table is the complete
/// list and drives every optional-null conversion in the boundary: a null in
/// any other optional field stays for the decoder to reject, and nulls inside
/// application data (state, metadata values, `rawEvent` and `result`
/// contents, tool arguments) are never touched. Each entry has a row in the
/// repo-root DEPRECATIONS.md. Copied from the TypeScript client's
/// compatibility boundary, key for key.
const Map<String, List<String>> optionalNulls = {
  /// On any event.
  'event': ['rawEvent', 'subagentRunId'],

  /// On the event type of the same name.
  'RUN_STARTED': ['parentRunId', 'input'],
  'RUN_FINISHED': ['result', 'outcome'],
  'RUN_ERROR': ['usage'],
  'SUBAGENT_FINISHED': ['result'],
  'TOOL_CALL_START': ['parentMessageId'],
  'TOOL_CALL_CHUNK': ['parentMessageId'],
  'TOOL_CALL_RESULT': ['role'],
  'RUN_FINISHED.outcome': ['pendingToolCallIds'],
  'RUN_FINISHED.usage[]': [
    'provider',
    'reasoningTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
  ],

  /// Inside a RunAgentInput (here: RUN_STARTED.input).
  'RunAgentInput': ['forwardedProps'],
  'Tool': ['parameters'],
  'ResumeEntry': ['payload'],

  /// On an image, audio, video or document content part.
  'input content': ['metadata'],
};

/// [value] without those of [fields] that are `null`, announcing each one.
/// [label] names the location (none for the fields allowed on any event).
/// Returns [value] itself when nothing was null and never mutates it.
Object? omitTabledNulls(
  Object? value,
  List<String> fields,
  String? label,
  NullNotice notice,
) {
  if (value is! Map) return value;
  Map<String, Object?>? rest;
  for (final field in fields) {
    if (!value.containsKey(field) || value[field] != null) continue;
    notice(label == null ? '$field: null' : '$label.$field: null');
    rest ??= Map<String, Object?>.from(value);
    rest.remove(field);
  }
  return rest ?? value;
}

/// Maps [field] of [value], an array, through [normalize], keeping the same
/// instance when no entry changed.
Object? mapProtocolArray(
  Object? value,
  String field,
  Object? Function(Object? entry) normalize,
) {
  if (value is! Map) return value;
  final original = value[field];
  if (original is! List) return value;
  final entries = [for (final entry in original) normalize(entry)];
  var changed = false;
  for (var i = 0; i < entries.length; i++) {
    if (!identical(entries[i], original[i])) {
      changed = true;
      break;
    }
  }
  if (!changed) return value;
  return Map<String, Object?>.from(value)..[field] = entries;
}

/// Normalises the media-part metadata nulls inside a message's content.
Object? normalizeLegacyMessageNulls(Object? message, NullNotice notice) =>
    mapProtocolArray(message, 'content', (part) {
      if (part is! Map) return part;
      return switch (part['type']) {
        'image' || 'audio' || 'video' || 'document' => omitTabledNulls(
          part,
          optionalNulls['input content']!,
          '${part['type']} input content',
          notice,
        ),
        _ => part,
      };
    });

/// Normalises only the whole optional nulls accepted by pre-1.0 request
/// parsers, inside a raw RunAgentInput (RUN_STARTED.input). Does not
/// validate or walk opaque application data.
Object? normalizeLegacyRunAgentInput(Object? input, NullNotice notice) {
  var normalized = omitTabledNulls(
    input,
    optionalNulls['RunAgentInput']!,
    'RunAgentInput',
    notice,
  );
  normalized = mapProtocolArray(
    normalized,
    'tools',
    (tool) => omitTabledNulls(tool, optionalNulls['Tool']!, 'Tool', notice),
  );
  normalized = mapProtocolArray(
    normalized,
    'resume',
    (entry) => omitTabledNulls(
      entry,
      optionalNulls['ResumeEntry']!,
      'ResumeEntry',
      notice,
    ),
  );
  return mapProtocolArray(
    normalized,
    'messages',
    (message) => normalizeLegacyMessageNulls(message, notice),
  );
}
