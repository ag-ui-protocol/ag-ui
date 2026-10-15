// Port of sdks/typescript/packages/client/src/chunks/transform.ts.
//
// Expands the chunk shorthand (TEXT_MESSAGE_CHUNK, TOOL_CALL_CHUNK,
// REASONING_MESSAGE_CHUNK) into the explicit START / CONTENT|ARGS / END
// triads every later stage is written against.
//
// Differences from the TypeScript stage, all forced by the Dart model:
//
// - Absent and null are one state here. The generated decoder rejects a
//   `null` on an optional described field (`subagentRunId: null`,
//   `delta: null`) fatally before this stage runs, so the TS branches that
//   preserve a null for a later stage to reject have nothing to preserve.
// - The chunk classes keep no unrecognised properties (decoding drops them,
//   enforcement strips and names them first), so the TS "remainder" carried
//   onto the synthesized events, and its collision warning, has no
//   counterpart.
// - Debug logging is not ported.

import '../errors.dart';
import '../generated/models.dart';

/// Which family a lane's open stream belongs to.
enum _Kind { text, tool, reasoning }

/// The stream one lane is currently assembling from chunks. A lane holds at
/// most one, because the chunk shorthand identifies a continuation only by
/// "the same as before".
sealed class _Pending {
  const _Pending();

  _Kind get kind;

  /// The id the pending stream is keyed by, whichever kind it is.
  String get entityId;

  /// The subagent the opener attributed the stream to, if any.
  String? get subagentRunId;
}

final class _PendingText extends _Pending {
  const _PendingText({
    required this.messageId,
    required this.role,
    this.name,
    this.subagentRunId,
  });

  final String messageId;

  /// The role the opener ESTABLISHED — explicit, or the assistant default the
  /// synthesized START carried. Kept so a later chunk that repeats the field
  /// can be judged against what the stream already said.
  final TextMessageRole role;
  final String? name;
  @override
  final String? subagentRunId;

  @override
  _Kind get kind => _Kind.text;
  @override
  String get entityId => messageId;
}

final class _PendingTool extends _Pending {
  const _PendingTool({
    required this.toolCallId,
    required this.toolCallName,
    this.parentMessageId,
    this.subagentRunId,
  });

  final String toolCallId;
  final String toolCallName;
  final String? parentMessageId;
  @override
  final String? subagentRunId;

  @override
  _Kind get kind => _Kind.tool;
  @override
  String get entityId => toolCallId;
}

final class _PendingReasoning extends _Pending {
  const _PendingReasoning({required this.messageId, this.subagentRunId});

  final String messageId;
  @override
  final String? subagentRunId;

  @override
  _Kind get kind => _Kind.reasoning;
  @override
  String get entityId => messageId;
}

String _missingIdFieldName(_Kind kind) =>
    kind == _Kind.tool ? 'toolCallId' : 'messageId';

/// A continuation chunk MAY repeat a field its opener established, but only
/// with the same value. A conflicting repeat is a malformed known value, and
/// fatal — the same judgment the continuation-owner rule passes on
/// `subagentRunId`. Rejected here rather than left to verification because
/// the repeated field never survives expansion: the synthesized content event
/// does not carry it, so downstream stages would never see the disagreement.
void _requireOpenerAgreement(
  String entityKind,
  String entityId,
  String field,
  String? incoming,
  String? established,
) {
  if (incoming != null && incoming != established) {
    throw AguiProtocolException(
      "Cannot continue $entityKind '$entityId': chunk $field '$incoming' "
      "does not match the open stream's $field "
      "${established == null ? '(absent)' : "'$established'"}.",
    );
  }
}

/// Expands chunk events into explicit start/content/end events.
///
/// The chunk's `metadata` is stamped onto every event synthesized FROM that
/// chunk (opener and content), never onto the synthetic END that closes the
/// previous message, so a chunk's metadata does not leak onto the message it
/// is closing. The chunk's `rawEvent` rides only on the content event: that
/// is what the producer actually sent, while the opener is this stage's
/// invention.
///
/// A stream that completes with a lane still open emits no END for it: only
/// the run-level events below close every lane.
Stream<Event> transformChunks(Stream<Event> source) async* {
  // One pending stream per LANE, where a lane is the subagent its chunks are
  // attributed to and `null` is the parent agent. A single global slot let
  // two concurrently streaming subagents destroy each other's messages: the
  // second opener closed the first's message, and the first's next id-less
  // continuation then failed outright. A run that never attributes anything
  // uses only the `null` lane. Insertion-ordered, so closing every lane
  // closes them in the order they opened.
  final lanes = <String?, _Pending>{};

  /// The END for whatever [owner] has open, clearing the lane.
  List<Event> closeLane(String? owner) {
    final pending = lanes.remove(owner);
    if (pending == null) return const [];
    return [
      switch (pending) {
        _PendingText(:final messageId, :final subagentRunId) =>
          TextMessageEndEvent(
            messageId: messageId,
            subagentRunId: subagentRunId,
          ),
        _PendingTool(:final toolCallId, :final subagentRunId) =>
          ToolCallEndEvent(
            toolCallId: toolCallId,
            subagentRunId: subagentRunId,
          ),
        _PendingReasoning(:final messageId, :final subagentRunId) =>
          ReasoningMessageEndEvent(
            messageId: messageId,
            subagentRunId: subagentRunId,
          ),
      },
    ];
  }

  /// Close every lane, in the order they opened. Used by the run-level
  /// events, which describe the run as a whole rather than any one producer
  /// within it.
  List<Event> closeAllLanes() => [
    for (final owner in lanes.keys.toList()) ...closeLane(owner),
  ];

  /// The lane holding an open stream of [kind] under [entityId], if any. A
  /// record so that "held by the parent lane" (owner `null`) is
  /// distinguishable from "not held".
  ({String? owner})? laneHolding(_Kind kind, String entityId) {
    for (final MapEntry(key: owner, value: pending) in lanes.entries) {
      if (pending.kind == kind && pending.entityId == entityId) {
        return (owner: owner);
      }
    }
    return null;
  }

  /// Decide which lane a chunk belongs to. Every chunk may carry its own
  /// `subagentRunId`, which is what makes per-lane assembly possible at all —
  /// but the shorthand lets a continuation omit both the id and the tag, so
  /// the lane has to be inferred.
  String? resolveLane(
    _Kind kind,
    String? entityId,
    String? tag,
    String chunkType,
    String entityKind,
  ) {
    if (entityId != null) {
      // A named id continues wherever it is already open, regardless of who
      // sends it, so the id remains the strongest signal. A tag that
      // disagrees with that lane is the contradiction the continuation-owner
      // rule forbids: rejected here because a chunk carrying attribution but
      // no delta synthesizes nothing, so the disagreement would never reach
      // the verifier.
      final holder = laneHolding(kind, entityId);
      if (holder != null) {
        if (tag != null && tag != holder.owner) {
          throw AguiProtocolException(
            "Cannot continue $entityKind '$entityId': chunk subagentRunId "
            "'$tag' does not match the open stream's subagent "
            "'${holder.owner ?? '(the parent agent)'}'.",
          );
        }
        return holder.owner;
      }
      // An id nobody holds opens a new stream, in the lane its own tag names.
      return tag;
    }

    // Continuation shorthand. A tag names its lane outright.
    if (tag != null) return tag;

    // Untagged means the parent agent, so prefer the parent's own open
    // stream.
    if (lanes[null]?.kind == kind) return null;

    // Otherwise fall back to the sole open stream of this kind, so producers
    // that attribute only the opening chunk keep working. An id-less chunk can
    // never OPEN a stream, so when the parent has no stream of this kind the
    // sole open stream is the chunk's only possible referent.
    final candidates = [
      for (final entry in lanes.entries)
        if (entry.value.kind == kind) entry.key,
    ];
    if (candidates.length == 1) return candidates.single;
    if (candidates.length > 1) {
      throw AguiProtocolException(
        'Ambiguous $chunkType: it carries neither a '
        '${_missingIdFieldName(kind)} nor a subagentRunId, but '
        '${candidates.length} lanes have an open $entityKind. Attribute the '
        'chunk to the subagent it belongs to.',
      );
    }
    // Nothing to continue: the caller opens a new stream in the parent lane,
    // or reports the missing id.
    return null;
  }

  List<Event> expandText(TextMessageChunkEvent chunk) {
    final lane = resolveLane(
      _Kind.text,
      chunk.messageId,
      chunk.subagentRunId,
      'TEXT_MESSAGE_CHUNK',
      'text message',
    );
    final open = lanes[lane];
    final result = <Event>[];

    final _PendingText fields;
    if (open is _PendingText &&
        // An absent id continues; a present one must be the same message.
        (chunk.messageId == null || chunk.messageId == open.messageId)) {
      _requireOpenerAgreement(
        'text message',
        open.messageId,
        'role',
        chunk.role?.wireName,
        open.role.wireName,
      );
      _requireOpenerAgreement(
        'text message',
        open.messageId,
        'name',
        chunk.name,
        open.name,
      );
      fields = open;
    } else {
      // Whatever else this lane had open ends before the new stream begins.
      result.addAll(closeLane(lane));

      final messageId = chunk.messageId;
      if (messageId == null) {
        throw AguiProtocolException(
          'First TEXT_MESSAGE_CHUNK must have a messageId',
        );
      }

      fields = _PendingText(
        messageId: messageId,
        // Absent means assistant, which the spec states normatively and the
        // generated decoder deliberately does not apply, so materialising it
        // here is real work nothing else does.
        role: chunk.role ?? TextMessageRole.assistant,
        name: chunk.name,
        subagentRunId: chunk.subagentRunId,
      );
      lanes[lane] = fields;

      result.add(
        TextMessageStartEvent(
          messageId: messageId,
          role: fields.role,
          name: chunk.name,
          subagentRunId: chunk.subagentRunId,
          metadata: chunk.metadata,
        ),
      );
    }

    // A content event is emitted when the chunk carries a delta OR a provider
    // payload. The synthesized START claims no rawEvent, so a first chunk
    // carrying rawEvent but no delta needs this event as the payload's
    // carrier, exactly as a continuation does.
    //
    // A continuation carrying only metadata — a final chunk with usage and a
    // finish reason — synthesizes nothing else, so it too gets a zero-delta
    // content event, so the metadata still reaches the reducer. It cannot
    // ride the synthetic END instead: the last message of a stream has its
    // END synthesized by a later event, or never.
    if (chunk.delta != null ||
        chunk.rawEvent != null ||
        (result.isEmpty && chunk.metadata != null)) {
      result.add(
        TextMessageContentEvent(
          messageId: fields.messageId,
          delta: chunk.delta ?? '',
          // Prefer the INCOMING chunk's tag over the opener's, so a producer
          // that attributes every chunk sees its own attribution on the
          // output rather than a value this transform remembered.
          subagentRunId: chunk.subagentRunId ?? fields.subagentRunId,
          metadata: chunk.metadata,
          rawEvent: chunk.rawEvent,
        ),
      );
    }
    return result;
  }

  List<Event> expandTool(ToolCallChunkEvent chunk) {
    final lane = resolveLane(
      _Kind.tool,
      chunk.toolCallId,
      chunk.subagentRunId,
      'TOOL_CALL_CHUNK',
      'tool call',
    );
    final open = lanes[lane];
    final result = <Event>[];

    final _PendingTool fields;
    if (open is _PendingTool &&
        (chunk.toolCallId == null || chunk.toolCallId == open.toolCallId)) {
      _requireOpenerAgreement(
        'tool call',
        open.toolCallId,
        'toolCallName',
        chunk.toolCallName,
        open.toolCallName,
      );
      _requireOpenerAgreement(
        'tool call',
        open.toolCallId,
        'parentMessageId',
        chunk.parentMessageId,
        open.parentMessageId,
      );
      fields = open;
    } else {
      result.addAll(closeLane(lane));

      final toolCallId = chunk.toolCallId;
      if (toolCallId == null) {
        throw AguiProtocolException(
          'First TOOL_CALL_CHUNK must have a toolCallId',
        );
      }
      final toolCallName = chunk.toolCallName;
      if (toolCallName == null) {
        throw AguiProtocolException(
          'First TOOL_CALL_CHUNK must have a toolCallName',
        );
      }
      fields = _PendingTool(
        toolCallId: toolCallId,
        toolCallName: toolCallName,
        parentMessageId: chunk.parentMessageId,
        subagentRunId: chunk.subagentRunId,
      );
      lanes[lane] = fields;

      result.add(
        ToolCallStartEvent(
          toolCallId: toolCallId,
          toolCallName: toolCallName,
          parentMessageId: chunk.parentMessageId,
          subagentRunId: chunk.subagentRunId,
          metadata: chunk.metadata,
        ),
      );
    }

    // Same rule as the text arm above.
    if (chunk.delta != null ||
        chunk.rawEvent != null ||
        (result.isEmpty && chunk.metadata != null)) {
      result.add(
        ToolCallArgsEvent(
          toolCallId: fields.toolCallId,
          delta: chunk.delta ?? '',
          subagentRunId: chunk.subagentRunId ?? fields.subagentRunId,
          metadata: chunk.metadata,
          rawEvent: chunk.rawEvent,
        ),
      );
    }
    return result;
  }

  List<Event> expandReasoning(ReasoningMessageChunkEvent chunk) {
    final lane = resolveLane(
      _Kind.reasoning,
      chunk.messageId,
      chunk.subagentRunId,
      'REASONING_MESSAGE_CHUNK',
      'reasoning message',
    );
    final open = lanes[lane];
    final result = <Event>[];

    final _PendingReasoning fields;
    if (open is _PendingReasoning &&
        // Null-checked, not truthiness: an explicitly empty id is a present
        // id that denotes a NEW stream.
        (chunk.messageId == null || chunk.messageId == open.messageId)) {
      fields = open;
    } else {
      result.addAll(closeLane(lane));

      final messageId = chunk.messageId;
      if (messageId == null) {
        throw AguiProtocolException(
          'First REASONING_MESSAGE_CHUNK must have a messageId',
        );
      }
      fields = _PendingReasoning(
        messageId: messageId,
        subagentRunId: chunk.subagentRunId,
      );
      lanes[lane] = fields;

      // The role is the class's constant "reasoning".
      result.add(
        ReasoningMessageStartEvent(
          messageId: messageId,
          subagentRunId: chunk.subagentRunId,
          metadata: chunk.metadata,
        ),
      );
    }

    // Same rule as the text arm above.
    if (chunk.delta != null ||
        chunk.rawEvent != null ||
        (result.isEmpty && chunk.metadata != null)) {
      result.add(
        ReasoningMessageContentEvent(
          messageId: fields.messageId,
          delta: chunk.delta ?? '',
          subagentRunId: chunk.subagentRunId ?? fields.subagentRunId,
          metadata: chunk.metadata,
          rawEvent: chunk.rawEvent,
        ),
      );
    }
    return result;
  }

  /// The tag an explicit event carries; untagged events read as the parent
  /// lane, which is what they are.
  String? ownerOf(Event event) => switch (event) {
    Attributable(:final subagentRunId) => subagentRunId,
    _ => null,
  };

  await for (final event in source) {
    final out = switch (event) {
      TextMessageChunkEvent() => expandText(event),
      ToolCallChunkEvent() => expandTool(event),
      ReasoningMessageChunkEvent() => expandReasoning(event),

      // An explicit event closes only ITS OWN lane's pending stream, so a
      // parent's TEXT_MESSAGE_START cannot end a subagent's half-assembled
      // message.
      TextMessageStartEvent() ||
      TextMessageContentEvent() ||
      TextMessageEndEvent() ||
      ToolCallStartEvent() ||
      ToolCallArgsEvent() ||
      ToolCallEndEvent() ||
      ToolCallResultEvent() ||
      StateSnapshotEvent() ||
      StateDeltaEvent() ||
      CustomEvent() ||
      StepStartedEvent() ||
      StepFinishedEvent() ||
      ReasoningStartEvent() ||
      ReasoningMessageStartEvent() ||
      ReasoningMessageContentEvent() ||
      ReasoningMessageEndEvent() ||
      ReasoningEndEvent() => [...closeLane(ownerOf(event)), event],

      // Run-level events describe the run as a whole, so every lane closes —
      // otherwise a subagent's chunk stream would outlive the run that
      // carried it. MESSAGES_SNAPSHOT restates the entire conversation and
      // attributes per message rather than carrying one owner of its own.
      RunStartedEvent() ||
      RunFinishedEvent() ||
      RunErrorEvent() ||
      MessagesSnapshotEvent() => [...closeAllLanes(), event],

      // These never close a lane.
      RawEvent() ||
      ActivitySnapshotEvent() ||
      ActivityDeltaEvent() ||
      ReasoningEncryptedValueEvent() ||
      SubagentStartedEvent() => [event],

      // A subagent's terminal closes that subagent's lane (only), so a
      // message this transform synthesized is not closed on behalf of an
      // owner that has already ended — a consumer grouping by subagent would
      // attach it to a group it had already marked complete. The terminal's
      // `subagentRunId` is required, so it can never be read as the parent
      // lane.
      SubagentFinishedEvent(:final subagentRunId) ||
      SubagentErrorEvent(
        :final subagentRunId,
      ) => [...closeLane(subagentRunId), event],
    };
    for (final e in out) {
      yield e;
    }
  }
  // Source completed: lanes still open are dropped, not closed. The state is
  // local to this generator, so there is nothing to clear.
}
