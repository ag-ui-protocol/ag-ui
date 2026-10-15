import '../client/warnings.dart';
import '../errors.dart';
import '../generated/models.dart';

/// The verification stage: a stateful check that the event stream obeys the
/// protocol's lifecycle and streaming rules. Ported rule for rule, in the same
/// order, from the TypeScript client's `verify/verify.ts`; every error message
/// is reproduced verbatim because the conformance corpus asserts on them.
///
/// Conforming events pass through unchanged. The first violation is raised as
/// an [AguiProtocolException], which ends the stream.
///
/// Lifecycle summary:
/// - The first event must be RUN_STARTED (or RUN_ERROR).
/// - RUN_ERROR does not end the stream: it is delivered, and a following
///   RUN_STARTED begins a new run. Any other event after RUN_ERROR is
///   rejected.
/// - After RUN_FINISHED only RUN_ERROR or a new RUN_STARTED may follow.
/// - A RUN_STARTED after RUN_FINISHED / RUN_ERROR resets every per-run
///   tracking structure (open messages, tool calls, reasoning spans and
///   messages, steps, subagents and the retained owners).
///
/// [warn] is kept for parity with the TypeScript stage, whose only warning is
/// the compatibility notice for an event-level `subagentRunId: null`. A typed
/// [Event] cannot carry that null (the compatibility boundary removes it and
/// the decoder rejects it), so nothing here warns today.
Stream<Event> verifyEvents(Stream<Event> source, WarningSink warn) async* {
  final verifier = _Verifier();
  await for (final event in source) {
    verifier.check(event);
    yield event;
  }
}

/// The recorded owner of an entity. Present-with-null means the PARENT agent
/// owns it, which is just as much an owner as a subagent is; an absent map
/// entry means "unknown".
final class _Owner {
  const _Owner(this.subagentRunId);

  final String? subagentRunId;
}

const _parentAgent = '(the parent agent)';

final class _Verifier {
  // The sets below hold IDS ONLY: membership answers "is this entity still
  // open?". Ownership is NOT here — it lives in the owner maps below, which is
  // what every attribution check reads, openers included.
  final Set<String> _activeMessages = {}; // open text message IDs
  final Set<String> _activeToolCalls = {}; // open tool call IDs

  // Reasoning has TWO bracketed entities: a SPAN (REASONING_START ..
  // REASONING_END) and a reasoning MESSAGE (REASONING_MESSAGE_START ..
  // REASONING_MESSAGE_END). The span's id "namespaces nothing", so the two
  // are tracked separately — one id may legitimately name both without either
  // opener reading as a re-open of the other. Ownership is shared across both
  // kinds (see [_reasoningOwners]) so a span and the message inside it cannot
  // be claimed by different producers.
  //
  // REASONING_ENCRYPTED_VALUE continues an entity by `entityId`, its subtype
  // may route it to a different bucket, and it opens and closes nothing — so
  // it is checked for ownership only.
  final Set<String> _activeReasoningSpans = {}; // open REASONING_START ids
  final Set<String> _activeReasoningMessages =
      {}; // open REASONING_MESSAGE_START ids

  // Owners, retained for the whole run, in one bucket PER ENTITY KIND: an id
  // is only unique within a kind, so a message and a tool call may both be
  // called "x" without one overwriting the other's owner.
  //
  // Retained rather than cleared on close, because a continuation can
  // legitimately arrive after its entity closed — REASONING_ENCRYPTED_VALUE
  // with subtype "tool-call" after TOOL_CALL_END is the case in point.
  final Map<String, _Owner> _messageOwners = {};
  final Map<String, _Owner> _toolCallOwners = {};
  // Activity messages are keyed by their own messageId and continued by
  // ACTIVITY_DELTA, so they need an owner just like text messages. Presence in
  // this map is also what tells a replacing snapshot from a first one.
  final Map<String, _Owner> _activityOwners = {};
  final Map<String, _Owner> _reasoningOwners = {};

  bool _runFinished = false;
  bool _runError = false;
  bool _firstEventReceived = false;
  bool _runStarted = false;

  // Active steps, keyed by OWNER then name. A step name is only unique within
  // one agent: a subagent routinely runs the same graph shape as its parent,
  // so both may have a step called "tools" open at once. Nested rather than a
  // joined key so the parent (null) never collides with a subagent whose id
  // is the empty string, which is a legal opaque id. Insertion-ordered, like
  // the JS Map, so error messages list steps in the same order.
  final Map<String?, Set<String>> _activeSteps = {};

  Set<String> _stepsFor(String? owner) =>
      _activeSteps.putIfAbsent(owner, () => <String>{});

  bool get _anyStepsActive => _activeSteps.values.any((s) => s.isNotEmpty);

  final Set<String> _activeSubagents = {};

  // Ids closed by SUBAGENT_FINISHED / SUBAGENT_ERROR in this run. A
  // subagentRunId is a unique handle for ONE invocation, so
  // `STARTED(s1), FINISHED(s1), STARTED(s1)` must be rejected.
  //
  // Deliberately NOT used to reject later events tagged with a closed id:
  // attribution-only producers (which tag events but never send SUBAGENT_*)
  // must stay valid.
  final Set<String> _closedSubagents = {};

  void _resetRunState() {
    _activeMessages.clear();
    _activeToolCalls.clear();
    _activeReasoningSpans.clear();
    _activeReasoningMessages.clear();
    _messageOwners.clear();
    _toolCallOwners.clear();
    _activityOwners.clear();
    _reasoningOwners.clear();
    _activeSteps.clear();
    _activeSubagents.clear();
    _closedSubagents.clear();
    _runFinished = false;
    _runError = false;
    _runStarted = true;
  }

  /// Ownership seeded from replayed history: MESSAGES_SNAPSHOT and the
  /// RUN_STARTED input echo both put messages on the wire that later events
  /// can reference, so their owners (absent = the parent agent) go on record
  /// like an opener's would — and each assistant message's tool calls under
  /// the message's owner, since a ToolCall carries no owner of its own.
  /// Without this, reopening a replayed id under a DIFFERENT owner was
  /// accepted and the reducer appended into the recorded owner's message.
  ///
  /// [authoritative]: a snapshot restates the conversation and the reducer
  /// REPLACES each message, so its owner replaces the recorded one. The
  /// RUN_STARTED input echo is plain history and only seeds unclaimed ids.
  ///
  /// The TypeScript version also rejects a nested `subagentRunId: null`; a
  /// typed [Message] cannot carry one (the decoder rejects it).
  void _seedOwnersFromMessages(List<Message> messages, bool authoritative) {
    for (final msg in messages) {
      // Owners are per entity KIND, so the message seeds the bucket its role
      // streams through.
      final bucket = switch (msg) {
        ReasoningMessage() => _reasoningOwners,
        ActivityMessage() => _activityOwners,
        _ => _messageOwners,
      };
      if (authoritative || !bucket.containsKey(msg.id)) {
        bucket[msg.id] = _Owner(msg.subagentRunId);
      }
      if (msg is AssistantMessage) {
        for (final tc in msg.toolCalls ?? const <ToolCall>[]) {
          if (authoritative || !_toolCallOwners.containsKey(tc.id)) {
            _toolCallOwners[tc.id] = _Owner(msg.subagentRunId);
          }
        }
      }
    }
  }

  /// Subagent attribution consistency: a continuation/close event must not
  /// disagree with the owner of its entity (the opener). An absent tag is
  /// always allowed — attribution may be used without SUBAGENT_* lifecycle
  /// events, so the tag is deliberately NOT required to name an "active"
  /// subagent. An opener with no tag means the PARENT owns the entity, so a
  /// tagged continuation on it is still a disagreement.
  void _checkSubagentTag(
    Event event,
    String? evSubagentRunId,
    _Owner? owner,
    String entityKind,
    String entityId,
  ) {
    if (evSubagentRunId == null) return;
    if (owner != null && owner.subagentRunId != evSubagentRunId) {
      throw AguiProtocolException(
        "Cannot send '${event.type.wireName}': subagentRunId "
        "'$evSubagentRunId' does not match the $entityKind '$entityId' "
        "opener's subagent '${owner.subagentRunId ?? _parentAgent}'.",
      );
    }
  }

  void check(Event event) {
    final eventType = event.type;
    final wire = eventType.wireName;

    // A run that errored is over rather than active, but a new RUN_STARTED
    // may still begin a new run (exactly as after RUN_FINISHED): a stream can
    // legitimately carry more than one run, a replayed thread being the
    // common case.
    if (_runError && eventType != EventType.runStarted) {
      throw AguiProtocolException(
        "Cannot send event type '$wire': The run has already errored with "
        "'RUN_ERROR'. No further events can be sent.",
      );
    }

    // After RUN_FINISHED only RUN_ERROR or a new RUN_STARTED may follow.
    if (_runFinished &&
        eventType != EventType.runError &&
        eventType != EventType.runStarted) {
      throw AguiProtocolException(
        "Cannot send event type '$wire': The run has already finished with "
        "'RUN_FINISHED'. Start a new run with 'RUN_STARTED'.",
      );
    }

    // First-event requirement and sequential RUN_STARTED.
    if (!_firstEventReceived) {
      _firstEventReceived = true;
      if (eventType != EventType.runStarted &&
          eventType != EventType.runError) {
        throw const AguiProtocolException("First event must be 'RUN_STARTED'");
      }
    } else if (eventType == EventType.runStarted) {
      // Allowed after RUN_FINISHED or RUN_ERROR (a new run), but not during
      // an active run.
      if (_runStarted && !_runFinished && !_runError) {
        throw const AguiProtocolException(
          "Cannot send 'RUN_STARTED' while a run is still active. The "
          "previous run must be finished with 'RUN_FINISHED' before starting "
          'a new run.',
        );
      }
      if (_runFinished || _runError) _resetRunState();
    }

    // The TypeScript verifier now tolerates an event-level
    // `subagentRunId: null` (removing it with a compatibility warning) and
    // rejects nulls on the subagent lifecycle optionals, on
    // `outcome.interruptIds`, on interrupt tags, invalid SUBAGENT_FINISHED
    // outcome discriminants and non-string interrupt ids. None of these is
    // representable on a typed [Event]: the compatibility boundary removes
    // tabled nulls and the generated decoder rejects every other one, so
    // those checks have no Dart counterpart.

    switch (event) {
      // Text message flow.
      case TextMessageStartEvent(:final messageId, :final subagentRunId):
        if (_activeMessages.contains(messageId)) {
          throw AguiProtocolException(
            "Cannot send 'TEXT_MESSAGE_START' event: A text message with ID "
            "'$messageId' is already in progress. Complete it with "
            "'TEXT_MESSAGE_END' first.",
          );
        }
        // First writer wins. Owners are retained for the run, so a DIFFERENT
        // producer reopening a closed id is a contradiction: the reducer
        // would append its content into the first producer's message.
        final existing = _messageOwners[messageId];
        if (existing != null) {
          _checkSubagentTag(
            event,
            subagentRunId,
            existing,
            'message',
            messageId,
          );
        }
        _activeMessages.add(messageId);
        // An UNTAGGED reopen agrees with any owner but must not overwrite an
        // s1 record and hand the message to the parent.
        if (existing == null) _messageOwners[messageId] = _Owner(subagentRunId);

      case TextMessageContentEvent(:final messageId, :final subagentRunId):
        if (!_activeMessages.contains(messageId)) {
          throw AguiProtocolException(
            "Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message "
            "found with ID '$messageId'. Start a text message with "
            "'TEXT_MESSAGE_START' first.",
          );
        }
        _checkSubagentTag(
          event,
          subagentRunId,
          _messageOwners[messageId],
          'message',
          messageId,
        );

      case TextMessageEndEvent(:final messageId, :final subagentRunId):
        if (!_activeMessages.contains(messageId)) {
          throw AguiProtocolException(
            "Cannot send 'TEXT_MESSAGE_END' event: No active text message "
            "found with ID '$messageId'. A 'TEXT_MESSAGE_START' event must be "
            'sent first.',
          );
        }
        _checkSubagentTag(
          event,
          subagentRunId,
          _messageOwners[messageId],
          'message',
          messageId,
        );
        _activeMessages.remove(messageId);

      // Tool call flow.
      case ToolCallStartEvent(
        :final toolCallId,
        :final parentMessageId,
        :final subagentRunId,
      ):
        if (_activeToolCalls.contains(toolCallId)) {
          throw AguiProtocolException(
            "Cannot send 'TOOL_CALL_START' event: A tool call with ID "
            "'$toolCallId' is already in progress. Complete it with "
            "'TOOL_CALL_END' first.",
          );
        }

        // A tool call lives INSIDE the assistant message parentMessageId
        // names, and ToolCall carries no attribution of its own — so a call
        // whose explicit tag disagrees with that message's owner cannot be
        // represented and is rejected rather than silently reattributed. An
        // untagged call inherits the parent message's owner.
        final eventTag = subagentRunId;
        _Owner? inheritedOwner;
        if (parentMessageId != null) {
          final parentOwner = _messageOwners[parentMessageId];
          if (parentOwner != null) {
            if (eventTag != null && eventTag != parentOwner.subagentRunId) {
              throw AguiProtocolException(
                "Cannot send 'TOOL_CALL_START': subagentRunId '$eventTag' does "
                "not match its parent message '$parentMessageId' owner "
                "'${parentOwner.subagentRunId ?? _parentAgent}'. A tool call "
                'belongs to the message that carries it.',
              );
            }
            inheritedOwner = parentOwner;
          }
        }

        // First writer wins, as for TEXT_MESSAGE_START.
        final existing = _toolCallOwners[toolCallId];
        if (existing != null) {
          _checkSubagentTag(event, eventTag, existing, 'tool call', toolCallId);
          // An untagged reopen's EFFECTIVE owner is the one it inherits from
          // its parent message: a reopen under a parent with a different
          // owner would leave the reducer appending args into the first
          // parent while the new parent ends up with no call at all.
          if (eventTag == null &&
              inheritedOwner != null &&
              inheritedOwner.subagentRunId != existing.subagentRunId) {
            throw AguiProtocolException(
              "Cannot send 'TOOL_CALL_START': tool call '$toolCallId' is owned "
              "by '${existing.subagentRunId ?? _parentAgent}' but its parent "
              "message '$parentMessageId' is owned by "
              "'${inheritedOwner.subagentRunId ?? _parentAgent}'. A tool call "
              'belongs to the message that carries it.',
            );
          }
        }
        _activeToolCalls.add(toolCallId);
        if (existing == null) {
          _toolCallOwners[toolCallId] =
              eventTag != null
                  ? _Owner(eventTag)
                  : inheritedOwner ?? const _Owner(null);
        }

      case ToolCallArgsEvent(:final toolCallId, :final subagentRunId):
        if (!_activeToolCalls.contains(toolCallId)) {
          throw AguiProtocolException(
            "Cannot send 'TOOL_CALL_ARGS' event: No active tool call found "
            "with ID '$toolCallId'. Start a tool call with 'TOOL_CALL_START' "
            'first.',
          );
        }
        _checkSubagentTag(
          event,
          subagentRunId,
          _toolCallOwners[toolCallId],
          'tool call',
          toolCallId,
        );

      case ToolCallEndEvent(:final toolCallId, :final subagentRunId):
        if (!_activeToolCalls.contains(toolCallId)) {
          throw AguiProtocolException(
            "Cannot send 'TOOL_CALL_END' event: No active tool call found "
            "with ID '$toolCallId'. A 'TOOL_CALL_START' event must be sent "
            'first.',
          );
        }
        _checkSubagentTag(
          event,
          subagentRunId,
          _toolCallOwners[toolCallId],
          'tool call',
          toolCallId,
        );
        _activeToolCalls.remove(toolCallId);

      // Step flow.
      case StepStartedEvent(:final stepName, :final subagentRunId):
        if (_stepsFor(subagentRunId).contains(stepName)) {
          throw AguiProtocolException(
            'Step "$stepName" is already active for \'STEP_STARTED\''
            "${subagentRunId != null ? " in subagent '$subagentRunId'" : ''}",
          );
        }
        _stepsFor(subagentRunId).add(stepName);

      case StepFinishedEvent(:final stepName, :final subagentRunId):
        if (!_stepsFor(subagentRunId).contains(stepName)) {
          // A step with this name may be open under a DIFFERENT owner —
          // reported separately because a producer stamping attribution from
          // "whichever subagent is currently active" closes the parent's step
          // under a subagent's tag (or a subagent's step untagged), and the
          // generic "was not started" message sends the reader looking for a
          // STEP_STARTED that is in fact right there.
          String? otherOwner;
          var foundOther = false;
          for (final MapEntry(key: owner, value: names)
              in _activeSteps.entries) {
            if (owner != subagentRunId && names.contains(stepName)) {
              otherOwner = owner;
              foundOther = true;
              break;
            }
          }
          if (foundOther) {
            throw AguiProtocolException(
              "Cannot send 'STEP_FINISHED' for step \"$stepName\" attributed "
              'to ${_ownerPhrase(subagentRunId)}: that step is open under '
              '${_ownerPhrase(otherOwner)}. A step must be finished by '
              'whoever started it.',
            );
          }
          throw AguiProtocolException(
            "Cannot send 'STEP_FINISHED' for step \"$stepName\" that was not "
            'started',
          );
        }
        _stepsFor(subagentRunId).remove(stepName);

      // STATE_SNAPSHOT and STATE_DELTA are attributable, but attribution on
      // them is PROVENANCE, not ownership: the state stays run-scoped. The
      // protocol lists them as carrying attribution, so rejecting a tagged
      // one would make this client stricter than the protocol. No check.
      case StateSnapshotEvent() || StateDeltaEvent():
        break;

      // Activity messages are opened by ACTIVITY_SNAPSHOT and continued by
      // ACTIVITY_DELTA against the same messageId.
      case ActivitySnapshotEvent(
        :final messageId,
        :final replace,
        :final subagentRunId,
      ):
        // Only a REPLACING snapshot (replace absent or true) re-mints the
        // activity and so re-owns it. With replace:false the reducer leaves
        // the existing message alone, so re-owning here would let a delta
        // under the new tag patch a message still owned by someone else.
        // "Known" is the owners map itself, so seeded activities count.
        final isNew = !_activityOwners.containsKey(messageId);
        if (isNew || replace != false) {
          _activityOwners[messageId] = _Owner(subagentRunId);
        }

      case ToolCallResultEvent(:final messageId, :final subagentRunId):
        // A creation event: it mints the tool message the reducer inserts, so
        // the id goes on record. Unconditionally (newest mint wins): the
        // result carries its own attribution, as the executor can differ
        // from the caller, and an untagged result mints a parent-owned one.
        _messageOwners[messageId] = _Owner(subagentRunId);

      case ReasoningStartEvent(:final messageId, :final subagentRunId):
        _openReasoning(event, messageId, subagentRunId, isSpan: true);

      case ReasoningMessageStartEvent(:final messageId, :final subagentRunId):
        _openReasoning(event, messageId, subagentRunId, isSpan: false);

      case ReasoningMessageContentEvent(:final messageId, :final subagentRunId):
        _continueReasoning(event, messageId, subagentRunId, isSpan: false);

      case ReasoningMessageEndEvent(:final messageId, :final subagentRunId):
        _continueReasoning(event, messageId, subagentRunId, isSpan: false);
        _activeReasoningMessages.remove(messageId);

      case ReasoningEndEvent(:final messageId, :final subagentRunId):
        _continueReasoning(event, messageId, subagentRunId, isSpan: true);
        _activeReasoningSpans.remove(messageId);

      case ReasoningEncryptedValueEvent(
        :final entityId,
        :final subtype,
        :final subagentRunId,
      ):
        // Continues an entity by entityId; `subtype` says which kind. The
        // "message" subtype spans BOTH message kinds — a text message and a
        // reasoning message (attaching an encrypted value to a reasoning
        // message is its canonical use). Ids are unique per kind, so at most
        // one of the two buckets holds this id. (The TypeScript fallback for
        // an unknown subtype is unreachable here: the enum is closed.)
        final (owner, kindLabel) = switch (subtype) {
          ReasoningEncryptedValueSubtype.toolCall => (
            _toolCallOwners[entityId],
            'tool call',
          ),
          ReasoningEncryptedValueSubtype.message => (
            _messageOwners[entityId] ?? _reasoningOwners[entityId],
            'message',
          ),
        };
        _checkSubagentTag(event, subagentRunId, owner, kindLabel, entityId);

      case ActivityDeltaEvent(:final messageId, :final subagentRunId):
        _checkSubagentTag(
          event,
          subagentRunId,
          _activityOwners[messageId],
          'activity',
          messageId,
        );

      // Subagent flow. The TypeScript verifier also rejects a lifecycle
      // event without `subagentRunId` / `name` / (SUBAGENT_ERROR) `message`,
      // because in-process producers bypass its schema; here those fields are
      // non-nullable and the decoder rejects their absence.
      case SubagentStartedEvent(
        :final subagentRunId,
        :final parentSubagentRunId,
      ):
        if (_activeSubagents.contains(subagentRunId)) {
          throw AguiProtocolException(
            "Cannot send 'SUBAGENT_STARTED': subagent '$subagentRunId' is "
            "already active. Finish it with 'SUBAGENT_FINISHED' first.",
          );
        }
        // Ids are per-invocation: reopening a closed id would give one
        // invocation two starts and two terminals.
        if (_closedSubagents.contains(subagentRunId)) {
          throw AguiProtocolException(
            "Cannot send 'SUBAGENT_STARTED': subagent '$subagentRunId' has "
            'already finished in this run. Subagent IDs are per-invocation '
            'and cannot be reused.',
          );
        }
        if (parentSubagentRunId != null &&
            !_activeSubagents.contains(parentSubagentRunId) &&
            !_closedSubagents.contains(parentSubagentRunId)) {
          throw AguiProtocolException(
            "Cannot send 'SUBAGENT_STARTED': parentSubagentRunId "
            "'$parentSubagentRunId' has not been started in this run.",
          );
        }
        _activeSubagents.add(subagentRunId);

      case SubagentFinishedEvent(:final subagentRunId) ||
          SubagentErrorEvent(:final subagentRunId):
        if (!_activeSubagents.contains(subagentRunId)) {
          throw AguiProtocolException(
            "Cannot send '$wire': no active subagent found with ID "
            "'$subagentRunId'. A 'SUBAGENT_STARTED' event must be sent first.",
          );
        }
        _activeSubagents.remove(subagentRunId);
        _closedSubagents.add(subagentRunId);

      case MessagesSnapshotEvent(:final messages):
        // Authoritative: the reducer replaces each message.
        _seedOwnersFromMessages(messages, true);

      // Run flow.
      case RunStartedEvent(:final input):
        // Validated above.
        _runStarted = true;
        // The input echo carries replayed history the reducer applies, so it
        // seeds ownership non-authoritatively (history, not a rewrite).
        _seedOwnersFromMessages(input?.messages ?? const <Message>[], false);

      case RunFinishedEvent():
        // Not the first event, and not after a finish (both checked above).
        if (_anyStepsActive) {
          final parts = [
            for (final MapEntry(key: owner, value: names)
                in _activeSteps.entries)
              for (final name in names)
                owner != null ? "$name (subagent '$owner')" : name,
          ];
          throw AguiProtocolException(
            "Cannot send 'RUN_FINISHED' while steps are still active: "
            '${parts.join(', ')}',
          );
        }
        if (_activeMessages.isNotEmpty) {
          throw AguiProtocolException(
            "Cannot send 'RUN_FINISHED' while text messages are still active: "
            '${_activeMessages.join(', ')}',
          );
        }
        if (_activeReasoningMessages.isNotEmpty) {
          throw AguiProtocolException(
            "Cannot send 'RUN_FINISHED' while reasoning messages are still "
            'active: ${_activeReasoningMessages.join(', ')}',
          );
        }
        if (_activeReasoningSpans.isNotEmpty) {
          throw AguiProtocolException(
            "Cannot send 'RUN_FINISHED' while reasoning spans are still "
            'active: ${_activeReasoningSpans.join(', ')}',
          );
        }
        if (_activeToolCalls.isNotEmpty) {
          throw AguiProtocolException(
            "Cannot send 'RUN_FINISHED' while tool calls are still active: "
            '${_activeToolCalls.join(', ')}',
          );
        }
        if (_activeSubagents.isNotEmpty) {
          throw AguiProtocolException(
            "Cannot send 'RUN_FINISHED' while subagents are still active: "
            '${_activeSubagents.join(', ')}',
          );
        }
        _runFinished = true;

      case RunErrorEvent():
        // RUN_ERROR can happen at any time. It does not end the stream; only
        // a new RUN_STARTED may follow it.
        _runError = true;

      // Pass through without checks. The *_CHUNK events are expanded before
      // this stage runs; like the TypeScript default branch, they pass.
      case CustomEvent() ||
          RawEvent() ||
          TextMessageChunkEvent() ||
          ToolCallChunkEvent() ||
          ReasoningMessageChunkEvent():
        break;
    }
  }

  static String _ownerPhrase(String? owner) =>
      owner != null ? "subagent '$owner'" : 'the parent agent';

  /// REASONING_START / REASONING_MESSAGE_START.
  void _openReasoning(
    Event event,
    String messageId,
    String? subagentRunId, {
    required bool isSpan,
  }) {
    final open = isSpan ? _activeReasoningSpans : _activeReasoningMessages;
    // "A producer MUST NOT open a span whose messageId is already open", and
    // likewise a message. Checked against the opener's OWN set: a span and
    // the message inside it may share an id.
    if (open.contains(messageId)) {
      throw AguiProtocolException(
        isSpan
            ? "Cannot send 'REASONING_START' event: A reasoning span with ID "
                "'$messageId' is already in progress. Complete it with "
                "'REASONING_END' first."
            : "Cannot send 'REASONING_MESSAGE_START' event: A reasoning "
                "message with ID '$messageId' is already in progress. "
                "Complete it with 'REASONING_MESSAGE_END' first.",
      );
    }
    // First writer records the owner; a second opener that DISAGREES is a
    // contradiction (the reducer would mint the message from the second
    // while content kept being checked against the first).
    final existing = _reasoningOwners[messageId];
    if (existing != null) {
      _checkSubagentTag(
        event,
        subagentRunId,
        existing,
        'reasoning message',
        messageId,
      );
    }
    open.add(messageId);
    // The owner outlives the close, so an untagged reopen after
    // REASONING_END does not hand the reasoning back to the parent.
    if (existing == null) _reasoningOwners[messageId] = _Owner(subagentRunId);
  }

  /// REASONING_MESSAGE_CONTENT / REASONING_MESSAGE_END / REASONING_END. The
  /// caller drops the OPEN flag for the two terminals; the owner is retained
  /// for the run so a later REASONING_ENCRYPTED_VALUE still has one to check.
  void _continueReasoning(
    Event event,
    String messageId,
    String? subagentRunId, {
    required bool isSpan,
  }) {
    final open = isSpan ? _activeReasoningSpans : _activeReasoningMessages;
    // A continuation must name something that is open, exactly as for text
    // messages and tool calls; otherwise the reducer invents a message for an
    // orphaned fragment or appends to a closed one.
    if (!open.contains(messageId)) {
      throw AguiProtocolException(
        isSpan
            ? "Cannot send 'REASONING_END' event: No active reasoning span "
                "found with ID '$messageId'. A 'REASONING_START' event must "
                'be sent first.'
            : "Cannot send '${event.type.wireName}' event: No active reasoning "
                "message found with ID '$messageId'. Start a reasoning "
                "message with 'REASONING_MESSAGE_START' first.",
      );
    }
    _checkSubagentTag(
      event,
      subagentRunId,
      _reasoningOwners[messageId],
      'reasoning message',
      messageId,
    );
  }
}
