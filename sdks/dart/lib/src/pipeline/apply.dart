import 'dart:convert';

import '../client/agent.dart';
import '../client/warnings.dart';
import '../generated/models.dart';
import 'json_patch.dart';
import 'producer_version.dart';

/// The application stage: folds each event into [agent]'s `messages`, `state`
/// and `pendingInterrupts`, then yields it, so a listener that sees an event
/// sees the agent as that event left it.
///
/// A port of the TypeScript client's `defaultApplyEvents`
/// (`sdks/typescript/packages/client/src/apply/default.ts`). Dart has no
/// subscriber API, so every subscriber hook, mutation and stopPropagation
/// check in that source is absent here, and "emit updates" is the `yield`.
///
/// Like the TypeScript reducer it works on its own copy of the message list,
/// seeded from `agent.messages`, and on the state the run was started with
/// (`input.state`); each change is written back to the agent before the event
/// is yielded.
Stream<Event> applyEvents(
  AbstractAgent agent,
  RunAgentInput input,
  Stream<Event> source,
  WarningSink warn,
) async* {
  final reducer = _Reducer(agent, input, warn);
  await for (final event in source) {
    reducer.apply(event);
    yield event;
  }
}

/// The metadata namespace the TypeScript client owns for activity history.
/// Package-owned convention; the protocol-reserved `ag-ui` key is untouched.
const _activityHistoryMetadata = '@ag-ui/client';

/// Where a tool call lives: the index of its assistant message and its index
/// within that message's `toolCalls`.
typedef _ToolCallSite = ({int message, int call});

final class _Reducer {
  _Reducer(this.agent, RunAgentInput input, this.warn)
    : messages = List.of(agent.messages),
      state = input.state {
    _reindex();
  }

  final AbstractAgent agent;
  final WarningSink warn;

  /// The reducer's message list; written back to the agent on every change.
  List<Message> messages;

  /// The reducer's state; written back to the agent on every change.
  State state;

  // Lookup structures, so no per-event handler scans the message list. The
  // TypeScript reducer uses `find` for these; the answers are the same (the
  // first match in list order), they are only kept rather than recomputed.

  /// Message id → index of the first message with that id.
  final Map<String, int> _indexById = {};

  /// Tool call id → id of the first assistant message carrying it.
  final Map<String, String> _ownerByToolCall = {};

  void apply(Event event) {
    switch (event) {
      case TextMessageStartEvent():
        _textMessageStart(event);
      case TextMessageContentEvent():
        _textMessageContent(event);
      case TextMessageEndEvent():
        _textMessageEnd(event);
      case ToolCallStartEvent():
        _toolCallStart(event);
      case ToolCallArgsEvent():
        _toolCallArgs(event);
      case ToolCallEndEvent():
        _toolCallEnd(event);
      case ToolCallResultEvent():
        _toolCallResult(event);
      case StateSnapshotEvent():
        // Replace state with the literal snapshot — null, false, 0 and arrays
        // included. Copied so the agent's state never aliases the event.
        state = _deepCopy(event.snapshot);
        _commitState();
      case StateDeltaEvent():
        _stateDelta(event);
      case MessagesSnapshotEvent():
        _messagesSnapshot(event);
      case ActivitySnapshotEvent():
        _activitySnapshot(event);
      case ActivityDeltaEvent():
        _activityDelta(event);
      case ReasoningMessageStartEvent():
        _reasoningMessageStart(event);
      case ReasoningMessageContentEvent():
        _reasoningMessageContent(event);
      case ReasoningMessageEndEvent():
        _reasoningMessageEnd(event);
      case ReasoningEncryptedValueEvent():
        _reasoningEncryptedValue(event);
      case RunStartedEvent():
        _runStarted(event);
      case RunFinishedEvent():
        _runFinished(event);
      case RunErrorEvent():
      case RawEvent():
      case CustomEvent():
        // Nothing to apply: the TypeScript reducer only hands these to
        // subscribers.
        break;
      case ReasoningStartEvent():
      case ReasoningEndEvent():
      case SubagentStartedEvent():
      case SubagentFinishedEvent():
      case SubagentErrorEvent():
      case StepStartedEvent():
      case StepFinishedEvent():
        // Subscriber-only in the TypeScript client; see AGENTS.md ledger item 1.
        break;
      case TextMessageChunkEvent():
        throw StateError(
          'TEXT_MESSAGE_CHUNK must be transformed before being applied',
        );
      case ToolCallChunkEvent():
        throw StateError(
          'TOOL_CALL_CHUNK must be transformed before being applied',
        );
      case ReasoningMessageChunkEvent():
        throw StateError(
          'REASONING_MESSAGE_CHUNK must be transformed before being applied',
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Text messages

  void _textMessageStart(TextMessageStartEvent event) {
    final messageId = event.messageId;
    // A message with this id may already exist (e.g. created by TOOL_CALL_START
    // with the same parentMessageId).
    final index = _indexById[messageId];
    final existing = index == null ? null : messages[index];

    if (existing is ActivityMessage) {
      // Message ids are unique across the conversation, so an activity message
      // under this id means the producer reused it. Streaming text into it
      // would overwrite its structured content with a string. Leave it alone
      // and drop the text — and with it the event's metadata, which describes
      // a text message that never exists.
      warn(
        "TEXT_MESSAGE_START: Message '$messageId' is an activity message — "
        'message ids must be unique across activity and text messages',
      );
      return;
    }

    if (index == null) {
      // Text messages can be developer, system, assistant or user (not tool).
      final Message created = switch (event.role ?? TextMessageRole.assistant) {
        TextMessageRole.developer => DeveloperMessage(
          id: messageId,
          content: '',
          name: event.name,
          subagentRunId: event.subagentRunId,
        ),
        TextMessageRole.system => SystemMessage(
          id: messageId,
          content: '',
          name: event.name,
          subagentRunId: event.subagentRunId,
        ),
        TextMessageRole.assistant => AssistantMessage(
          id: messageId,
          content: '',
          name: event.name,
          subagentRunId: event.subagentRunId,
        ),
        TextMessageRole.user => UserMessage(
          id: messageId,
          content: '',
          name: event.name,
          subagentRunId: event.subagentRunId,
        ),
      };
      _append(_mergeMetadata(created, event));
      _commitMessages();
    } else if (event.metadata != null) {
      // An existing message is reused as is; TEXT_MESSAGE_CONTENT will extend
      // its content. Only the metadata changes here.
      messages[index] = _mergeMetadata(existing!, event);
      _commitMessages();
    }
  }

  void _textMessageContent(TextMessageContentEvent event) {
    final index = _indexById[event.messageId];
    if (index == null) {
      warn(
        "TEXT_MESSAGE_CONTENT: No message found with ID '${event.messageId}'",
      );
      return;
    }
    final target = messages[index];
    if (target is ActivityMessage) {
      // Appending here would replace the activity message's structured
      // content with a string, leaving it no longer a valid ActivityMessage.
      warn(
        "TEXT_MESSAGE_CONTENT: Message '${event.messageId}' is an activity "
        'message — message ids must be unique across activity and text '
        'messages',
      );
      return;
    }
    messages[index] = _mergeMetadata(
      _withContent(target, '${_textOf(target)}${event.delta}'),
      event,
    );
    _commitMessages();
  }

  void _textMessageEnd(TextMessageEndEvent event) {
    final index = _indexById[event.messageId];
    if (index == null) {
      warn("TEXT_MESSAGE_END: No message found with ID '${event.messageId}'");
      return;
    }
    final target = messages[index];
    if (target is ActivityMessage) {
      // The matching TEXT_MESSAGE_START was dropped for the same reason, so
      // there is no text message to finish.
      warn(
        "TEXT_MESSAGE_END: Message '${event.messageId}' is an activity "
        'message — message ids must be unique across activity and text '
        'messages',
      );
      return;
    }
    // An end event is where late-known values — token usage, finish reason —
    // typically arrive.
    if (event.metadata != null) {
      messages[index] = _mergeMetadata(target, event);
      _commitMessages();
    }
  }

  // ---------------------------------------------------------------------------
  // Tool calls

  void _toolCallStart(ToolCallStartEvent event) {
    final toolCallId = event.toolCallId;

    // Applying a start event must be idempotent. The same start can reach this
    // reducer twice — a tool call already carried in the messages from an
    // earlier run and replayed by the backend (the HITL path does this when the
    // run re-syncs), or one stream re-delivered over two transports. Appending
    // unconditionally would leave the assistant message holding the id twice,
    // the second copy empty because TOOL_CALL_ARGS resolves to the first match.
    // Resolve the existing entry first, so a replay can't append a stray empty
    // assistant message either.
    final site = _findToolCall(toolCallId);
    if (site != null) {
      final owner = messages[site.message] as AssistantMessage;
      final existing = owner.toolCalls![site.call];
      // Update the existing entry instead of pushing a second one, and leave
      // `arguments` untouched — a start event carries none.
      final renamed = existing.function.name != event.toolCallName;
      if (renamed) {
        warn(
          "TOOL_CALL_START: tool call '$toolCallId' already exists with name "
          "'${existing.function.name}' — updating it to "
          "'${event.toolCallName}'",
        );
      }
      if (renamed || event.metadata != null) {
        _replaceToolCall(
          site,
          _toolCallWith(
            existing,
            name: event.toolCallName,
            metadata: _mergedMetadata(existing.metadata, event),
          ),
        );
        _commitMessages();
      }
      return;
    }

    final targetIndex = _resolveOrCreateAssistantMessage(event);
    final target = messages[targetIndex] as AssistantMessage;
    final call = ToolCall(
      id: toolCallId,
      function: FunctionCall(name: event.toolCallName, arguments: ''),
      metadata: _mergedMetadata(null, event),
    );
    messages[targetIndex] = _withToolCalls(target, [
      ...?target.toolCalls,
      call,
    ]);
    _ownerByToolCall.putIfAbsent(toolCallId, () => target.id);
    _commitMessages();
  }

  /// Resolves (or creates) the assistant message a tool call attaches to, and
  /// returns its index.
  ///
  /// Resolution order:
  /// 1. `parentMessageId` matches an existing assistant message — use it.
  /// 2. `parentMessageId` matches a non-assistant message (collision) — create
  ///    a new one, keyed by `toolCallId`.
  /// 3. `parentMessageId` not found — create a new one keyed by it.
  /// 4. No `parentMessageId` — create a new one keyed by `toolCallId`.
  int _resolveOrCreateAssistantMessage(ToolCallStartEvent event) {
    final parentMessageId = event.parentMessageId;
    // An empty id counts as absent, as it does in the TypeScript truthiness
    // check.
    if (parentMessageId != null && parentMessageId.isNotEmpty) {
      final index = _indexById[parentMessageId];
      final existing = index == null ? null : messages[index];
      if (existing is AssistantMessage) return index!;
      if (existing != null) {
        warn(
          "TOOL_CALL_START: parentMessageId '$parentMessageId' matches a "
          "'${existing.role}' message, not assistant — falling back to "
          'toolCallId',
        );
      }
      return _createAssistant(
        existing != null ? event.toolCallId : parentMessageId,
        event.subagentRunId,
      );
    }
    return _createAssistant(event.toolCallId, event.subagentRunId);
  }

  int _createAssistant(String id, String? subagentRunId) {
    // The start event's attribution transfers to a message it mints — but not
    // when the id already existed, mirroring the TypeScript `wasCreated` check.
    final wasCreated = !_indexById.containsKey(id);
    _append(
      AssistantMessage(
        id: id,
        toolCalls: const [],
        subagentRunId: wasCreated ? subagentRunId : null,
      ),
    );
    return messages.length - 1;
  }

  void _toolCallArgs(ToolCallArgsEvent event) {
    final site = _findToolCall(event.toolCallId);
    if (site == null) {
      warn(
        'TOOL_CALL_ARGS: No message found containing tool call with ID '
        "'${event.toolCallId}'",
      );
      return;
    }
    final call =
        (messages[site.message] as AssistantMessage).toolCalls![site.call];
    _replaceToolCall(
      site,
      _toolCallWith(
        call,
        arguments: '${call.function.arguments}${event.delta}',
        metadata: _mergedMetadata(call.metadata, event),
      ),
    );
    _commitMessages();
  }

  void _toolCallEnd(ToolCallEndEvent event) {
    final site = _findToolCall(event.toolCallId);
    if (site == null) {
      warn(
        'TOOL_CALL_END: No message found containing tool call with ID '
        "'${event.toolCallId}'",
      );
      return;
    }
    // An end event carries the values only known once the call is closed.
    if (event.metadata != null) {
      final call =
          (messages[site.message] as AssistantMessage).toolCalls![site.call];
      _replaceToolCall(
        site,
        _toolCallWith(call, metadata: _mergedMetadata(call.metadata, event)),
      );
      _commitMessages();
    }
  }

  void _toolCallResult(ToolCallResultEvent event) {
    final toolMessage = ToolMessage(
      id: event.messageId,
      toolCallId: event.toolCallId,
      content: event.content,
      subagentRunId: event.subagentRunId,
      metadata: _mergedMetadata(null, event),
    );

    // Place the tool result immediately after the assistant message that
    // issued the matching tool call — not at the end. A result can arrive
    // after a trailing assistant text message (a chat -> tool -> chat loop
    // streams the follow-up text first). Appending would leave the history as
    // assistant(tool_call) -> text -> tool, which violates the provider
    // contract that a tool call is immediately followed by its result. Skip
    // past results already recorded for the same assistant so parallel
    // results keep their order. Fall back to append when no owner is found.
    final site = _findToolCall(event.toolCallId);
    if (site == null) {
      _append(toolMessage);
    } else {
      var insertAt = site.message + 1;
      while (insertAt < messages.length && messages[insertAt] is ToolMessage) {
        insertAt++;
      }
      _insert(insertAt, toolMessage);
    }
    _commitMessages();
  }

  // ---------------------------------------------------------------------------
  // State

  void _stateDelta(StateDeltaEvent event) {
    try {
      // Applies to a copy; on failure the current state is kept untouched.
      state = applyJsonPatch(state, event.delta);
      _commitState();
    } catch (error) {
      final message = error is FormatException ? error.message : '$error';
      warn(
        'Failed to apply state patch:\n'
        'Current state: ${_prettyJson(state)}\n'
        'Patch operations: '
        '${_prettyJson([for (final op in event.delta) op.toJson()])}\n'
        'Error: $message',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Messages snapshot

  void _messagesSnapshot(MessagesSnapshotEvent event) {
    final newMessages = event.messages;
    // Update existing messages in place and append new snapshot messages,
    // preserving client-only messages the backend leaves out.
    final snapshotById = <String, Message>{
      for (final m in newMessages) m.id: m,
    };

    // `activity` messages are only sometimes client-only. They never travel
    // back to the backend, so a backend that does not track them cannot put
    // them in the snapshot, and the local copies must be preserved. But a
    // backend that does track them re-delivers the whole set it owns: once a
    // snapshot carries any activity, one it leaves out has been removed.
    //
    // `reasoning` messages likewise: most backends never include them, but one
    // that round-trips reasoning re-delivers it under its own canonical id, so
    // preserving the streamed copy would render the same reasoning twice.
    //
    // Explicit null authority replaces all activity types, including an empty
    // set. Arrays replace only their types; absent declarations use the rule
    // above. Invalid declarations own no types. Matching ids always update.
    final authority = _authoritativeActivityTypes(event);
    final snapshotHasActivity = newMessages.any((m) => m is ActivityMessage);
    final snapshotHasReasoning = newMessages.any((m) => m is ReasoningMessage);
    bool isPreservedClientOnly(Message m) => switch (m) {
      ActivityMessage(:final activityType) =>
        authority.declared
            ? authority.types != null &&
                !authority.types!.contains(activityType)
            : !snapshotHasActivity,
      ReasoningMessage() => !snapshotHasReasoning,
      _ => false,
    };

    final reconciled = <Message>[
      for (final m in messages)
        if (snapshotById.containsKey(m.id) || isPreservedClientOnly(m))
          snapshotById[m.id] ?? m,
    ];
    final existingIds = {for (final m in reconciled) m.id};
    for (final m in newMessages) {
      if (!existingIds.contains(m.id)) reconciled.add(m);
    }

    messages = reconciled;
    _reindex();
    _commitMessages();
  }

  /// The activity types a snapshot declares authority over, read from its
  /// `@ag-ui/client` metadata. `declared: false` means absent (legacy
  /// inference); `types: null` owns every type; a list owns those types.
  ({bool declared, Set<String>? types}) _authoritativeActivityTypes(
    MessagesSnapshotEvent event,
  ) {
    const absent = (declared: false, types: null);
    const ownsNone = (declared: true, types: <String>{});
    final metadata = event.metadata;
    if (metadata == null || !metadata.containsKey(_activityHistoryMetadata)) {
      return absent;
    }
    final value = metadata[_activityHistoryMetadata];
    if (value is! Map<String, Object?>) return ownsNone;
    if (!value.containsKey('authoritativeActivityTypes')) return absent;
    final types = value['authoritativeActivityTypes'];
    if (types == null) return (declared: true, types: null);
    if (types is List<Object?> && types.every((t) => t is String)) {
      return (declared: true, types: types.cast<String>().toSet());
    }
    return ownsNone;
  }

  // ---------------------------------------------------------------------------
  // Activity

  void _activitySnapshot(ActivitySnapshotEvent event) {
    final index = _indexById[event.messageId];
    final existing = index == null ? null : messages[index];
    final replace = event.replace ?? true;
    final activityMessage = ActivityMessage(
      id: event.messageId,
      activityType: event.activityType,
      content: _deepCopy(event.content) as Map<String, Object?>,
      subagentRunId: event.subagentRunId,
    );

    if (index == null) {
      _append(_mergeMetadata(activityMessage, event));
    } else if (existing is ActivityMessage) {
      if (replace) {
        // A snapshot replaces content, not the metadata built up so far.
        // Attribution is the exception: a replace snapshot re-mints the
        // activity, so it brings its own subagentRunId (or none) with it.
        messages[index] = ActivityMessage(
          id: existing.id,
          activityType: event.activityType,
          content: activityMessage.content,
          subagentRunId: event.subagentRunId,
          metadata: existing.metadata,
        );
      }
      messages[index] = _mergeMetadata(messages[index], event);
    } else if (replace) {
      // A non-activity message under this id is replaced outright. It may have
      // owned tool calls, so the lookups are rebuilt (rare path).
      messages[index] = _mergeMetadata(activityMessage, event);
      _reindex();
    }
    // A non-replacing snapshot over a non-activity message changes nothing.
    _commitMessages();
  }

  void _activityDelta(ActivityDeltaEvent event) {
    final index = _indexById[event.messageId];
    // A delta for a message that does not exist is tolerated silently.
    if (index == null) return;

    final existing = messages[index];
    if (existing is! ActivityMessage) {
      warn(
        "ACTIVITY_DELTA: Message '${event.messageId}' is not an activity "
        'message',
      );
      return;
    }

    // Metadata does not depend on the patch succeeding — a stale path should
    // not cost the message its usage or trace keys — so merge it first and
    // keep it either way.
    var current = existing;
    if (event.metadata != null) {
      current = _mergeMetadata(existing, event) as ActivityMessage;
      messages[index] = current;
      _commitMessages();
    }

    try {
      final patched = applyJsonPatch(current.content, event.patch);
      if (patched is! Map<String, Object?>) {
        // The TypeScript client would store any JSON value here; an
        // ActivityMessage's content is an object, so anything else is a
        // failed patch.
        throw const FormatException('the patched content is not an object');
      }
      messages[index] = ActivityMessage(
        id: current.id,
        activityType: event.activityType,
        content: patched,
        subagentRunId: current.subagentRunId,
        metadata: current.metadata,
      );
      _commitMessages();
    } catch (error) {
      final message = error is FormatException ? error.message : '$error';
      warn("Failed to apply activity patch for '${event.messageId}': $message");
    }
  }

  // ---------------------------------------------------------------------------
  // Reasoning

  void _reasoningMessageStart(ReasoningMessageStartEvent event) {
    final messageId = event.messageId;
    final index = _indexById[messageId];
    final existing = index == null ? null : messages[index];

    if (existing is ActivityMessage) {
      // Same reuse guard as TEXT_MESSAGE_START: drop the event and its
      // metadata rather than overwrite structured content with a string.
      warn(
        "REASONING_MESSAGE_START: Message '$messageId' is an activity "
        'message — message ids must be unique across activity and reasoning '
        'messages',
      );
      return;
    }

    if (index == null) {
      _append(
        _mergeMetadata(
          ReasoningMessage(
            id: messageId,
            content: '',
            subagentRunId: event.subagentRunId,
          ),
          event,
        ),
      );
      _commitMessages();
    } else if (event.metadata != null) {
      messages[index] = _mergeMetadata(existing!, event);
      _commitMessages();
    }
  }

  void _reasoningMessageContent(ReasoningMessageContentEvent event) {
    final index = _indexById[event.messageId];
    if (index == null) {
      warn(
        'REASONING_MESSAGE_CONTENT: No message found with ID '
        "'${event.messageId}'",
      );
      return;
    }
    final target = messages[index];
    if (target is ActivityMessage) {
      warn(
        "REASONING_MESSAGE_CONTENT: Message '${event.messageId}' is an "
        'activity message — message ids must be unique across activity and '
        'reasoning messages',
      );
      return;
    }
    messages[index] = _mergeMetadata(
      _withContent(target, '${_textOf(target)}${event.delta}'),
      event,
    );
    _commitMessages();
  }

  void _reasoningMessageEnd(ReasoningMessageEndEvent event) {
    final index = _indexById[event.messageId];
    if (index == null) {
      warn(
        "REASONING_MESSAGE_END: No message found with ID '${event.messageId}'",
      );
      return;
    }
    final target = messages[index];
    if (target is ActivityMessage) {
      warn(
        "REASONING_MESSAGE_END: Message '${event.messageId}' is an activity "
        'message — message ids must be unique across activity and reasoning '
        'messages',
      );
      return;
    }
    if (event.metadata != null) {
      messages[index] = _mergeMetadata(target, event);
      _commitMessages();
    }
  }

  /// REASONING_ENCRYPTED_VALUE attaches an encrypted blob to an entity that
  /// already exists; it does not build one, so its metadata stays on the
  /// event. An unknown entity is tolerated silently.
  void _reasoningEncryptedValue(ReasoningEncryptedValueEvent event) {
    switch (event.subtype) {
      case ReasoningEncryptedValueSubtype.toolCall:
        final site = _findToolCall(event.entityId);
        if (site == null) return;
        final call =
            (messages[site.message] as AssistantMessage).toolCalls![site.call];
        _replaceToolCall(
          site,
          _toolCallWith(call, encryptedValue: event.encryptedValue),
        );
      case ReasoningEncryptedValueSubtype.message:
        final index = _indexById[event.entityId];
        if (index == null) return;
        final target = messages[index];
        // Activity messages have no encryptedValue.
        if (target is ActivityMessage) return;
        messages[index] = _withEncryptedValue(target, event.encryptedValue);
    }
    _commitMessages();
  }

  // ---------------------------------------------------------------------------
  // Run lifecycle

  void _runStarted(RunStartedEvent event) {
    warnOnProducerDeclaration(event, warn);
    // The TypeScript reducer also resets its per-run tool call tally here; that
    // tally only feeds subscriber parameters, so it has no Dart counterpart.
    final inputMessages = event.input?.messages;
    if (inputMessages == null) return;
    // Add the input messages that aren't already present (checked by id).
    for (final message in inputMessages) {
      if (!_indexById.containsKey(message.id)) _append(message);
    }
    _commitMessages();
  }

  void _runFinished(RunFinishedEvent event) {
    // Defensive copy, so a consumer holding the event can't reach the agent's
    // tracked list through aliasing. Any outcome but interrupt clears it.
    final outcome = event.outcome;
    agent.pendingInterrupts =
        outcome is RunFinishedInterruptOutcome
            ? List.of(outcome.interrupts)
            : const [];
  }

  // ---------------------------------------------------------------------------
  // Bookkeeping

  void _commitMessages() => agent.messages = messages;

  void _commitState() => agent.state = state;

  /// Rebuilds both lookups from scratch: on construction, on a messages
  /// snapshot, and on the rare replacement that can drop tool calls.
  void _reindex() {
    _indexById.clear();
    _ownerByToolCall.clear();
    for (var i = 0; i < messages.length; i++) {
      _register(messages[i], i);
    }
  }

  void _register(Message message, int index) {
    _indexById.putIfAbsent(message.id, () => index);
    if (message is AssistantMessage) {
      for (final call in message.toolCalls ?? const <ToolCall>[]) {
        _ownerByToolCall.putIfAbsent(call.id, () => message.id);
      }
    }
  }

  void _append(Message message) {
    messages.add(message);
    _register(message, messages.length - 1);
  }

  /// Inserts [message] at [at], shifting the indices of the messages after
  /// it. Only the tail is touched, which for a tool result is normally empty
  /// or a handful of messages.
  void _insert(int at, Message message) {
    if (at >= messages.length) {
      _append(message);
      return;
    }
    messages.insert(at, message);
    // Walk backwards so a later duplicate id can't be mistaken for the first
    // occurrence that just moved.
    for (var i = messages.length - 1; i > at; i--) {
      final id = messages[i].id;
      if (_indexById[id] == i - 1) _indexById[id] = i;
    }
    final first = _indexById[message.id];
    if (first == null || first > at) _indexById[message.id] = at;
  }

  /// The first assistant message carrying [toolCallId], and the call's
  /// position in it — what the TypeScript reducer's `find` returns.
  _ToolCallSite? _findToolCall(String toolCallId) {
    final ownerId = _ownerByToolCall[toolCallId];
    if (ownerId == null) return null;
    final index = _indexById[ownerId];
    if (index != null) {
      final call = _callIndex(messages[index], toolCallId);
      if (call != null) return (message: index, call: call);
    }
    // Only reachable when message ids are duplicated and the owner is not the
    // first message with its id: fall back to a scan.
    for (var i = 0; i < messages.length; i++) {
      final call = _callIndex(messages[i], toolCallId);
      if (call != null) return (message: i, call: call);
    }
    return null;
  }

  static int? _callIndex(Message message, String toolCallId) {
    if (message is! AssistantMessage) return null;
    final calls = message.toolCalls;
    if (calls == null) return null;
    for (var i = 0; i < calls.length; i++) {
      if (calls[i].id == toolCallId) return i;
    }
    return null;
  }

  void _replaceToolCall(_ToolCallSite site, ToolCall call) {
    final owner = messages[site.message] as AssistantMessage;
    final calls = List.of(owner.toolCalls!);
    calls[site.call] = call;
    messages[site.message] = _withToolCalls(owner, calls);
  }
}

// -----------------------------------------------------------------------------
// Immutable-update helpers. The generated classes have no copyWith, so each
// helper rebuilds the concrete class with every field carried over.

/// Folds an event's metadata into the existing metadata, key by key, the last
/// write winning; null when the event has none. The incoming values are
/// copied so the event payload can't alias into the message list.
///
/// The target is a message, or a tool call for the TOOL_CALL_* events — a tool
/// call is not a message, and several can share one parent, so folding theirs
/// into the parent would make the result depend on their order. Metadata on a
/// run-, step- or state-level event belongs to that event and never reaches
/// either.
Map<String, Object?>? _mergedMetadata(
  Map<String, Object?>? existing,
  Event event,
) {
  final incoming = event.metadata;
  if (incoming == null) return existing;
  return {...?existing, ...(_deepCopy(incoming) as Map<String, Object?>)};
}

Message _mergeMetadata(Message message, Event event) {
  if (event.metadata == null) return message;
  return _withMetadata(message, _mergedMetadata(message.metadata, event)!);
}

/// The message's current text, or '' when its content is not a string (a
/// user or tool message carrying parts), as the TypeScript reducer reads it.
String _textOf(Message message) => switch (message) {
  DeveloperMessage(:final content) => content,
  SystemMessage(:final content) => content,
  AssistantMessage(:final content) => content ?? '',
  UserMessage(:final content) => content is String ? content : '',
  ToolMessage(:final content) => content is String ? content : '',
  ReasoningMessage(:final content) => content,
  ActivityMessage() => '',
};

Message _withContent(Message m, String content) => switch (m) {
  DeveloperMessage() => DeveloperMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    name: m.name,
    encryptedValue: m.encryptedValue,
    metadata: m.metadata,
    content: content,
  ),
  SystemMessage() => SystemMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    name: m.name,
    encryptedValue: m.encryptedValue,
    metadata: m.metadata,
    content: content,
  ),
  AssistantMessage() => AssistantMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    name: m.name,
    encryptedValue: m.encryptedValue,
    metadata: m.metadata,
    content: content,
    toolCalls: m.toolCalls,
  ),
  UserMessage() => UserMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    name: m.name,
    encryptedValue: m.encryptedValue,
    metadata: m.metadata,
    content: content,
  ),
  ToolMessage() => ToolMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    content: content,
    toolCallId: m.toolCallId,
    error: m.error,
    encryptedValue: m.encryptedValue,
    metadata: m.metadata,
  ),
  ReasoningMessage() => ReasoningMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    content: content,
    encryptedValue: m.encryptedValue,
    metadata: m.metadata,
  ),
  // Callers guard against this: streaming text into an activity message
  // would destroy its structured content.
  ActivityMessage() =>
    throw StateError('Cannot set text content on activity message ${m.id}'),
};

Message _withMetadata(Message m, Map<String, Object?> metadata) => switch (m) {
  DeveloperMessage() => DeveloperMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    name: m.name,
    encryptedValue: m.encryptedValue,
    metadata: metadata,
    content: m.content,
  ),
  SystemMessage() => SystemMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    name: m.name,
    encryptedValue: m.encryptedValue,
    metadata: metadata,
    content: m.content,
  ),
  AssistantMessage() => AssistantMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    name: m.name,
    encryptedValue: m.encryptedValue,
    metadata: metadata,
    content: m.content,
    toolCalls: m.toolCalls,
  ),
  UserMessage() => UserMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    name: m.name,
    encryptedValue: m.encryptedValue,
    metadata: metadata,
    content: m.content,
  ),
  ToolMessage() => ToolMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    content: m.content,
    toolCallId: m.toolCallId,
    error: m.error,
    encryptedValue: m.encryptedValue,
    metadata: metadata,
  ),
  ActivityMessage() => ActivityMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    activityType: m.activityType,
    content: m.content,
    metadata: metadata,
  ),
  ReasoningMessage() => ReasoningMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    content: m.content,
    encryptedValue: m.encryptedValue,
    metadata: metadata,
  ),
};

Message _withEncryptedValue(Message m, String encryptedValue) => switch (m) {
  DeveloperMessage() => DeveloperMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    name: m.name,
    encryptedValue: encryptedValue,
    metadata: m.metadata,
    content: m.content,
  ),
  SystemMessage() => SystemMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    name: m.name,
    encryptedValue: encryptedValue,
    metadata: m.metadata,
    content: m.content,
  ),
  AssistantMessage() => AssistantMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    name: m.name,
    encryptedValue: encryptedValue,
    metadata: m.metadata,
    content: m.content,
    toolCalls: m.toolCalls,
  ),
  UserMessage() => UserMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    name: m.name,
    encryptedValue: encryptedValue,
    metadata: m.metadata,
    content: m.content,
  ),
  ToolMessage() => ToolMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    content: m.content,
    toolCallId: m.toolCallId,
    error: m.error,
    encryptedValue: encryptedValue,
    metadata: m.metadata,
  ),
  ReasoningMessage() => ReasoningMessage(
    subagentRunId: m.subagentRunId,
    id: m.id,
    content: m.content,
    encryptedValue: encryptedValue,
    metadata: m.metadata,
  ),
  // Activity messages have no encryptedValue; callers skip them.
  ActivityMessage() => m,
};

AssistantMessage _withToolCalls(AssistantMessage m, List<ToolCall> toolCalls) =>
    AssistantMessage(
      subagentRunId: m.subagentRunId,
      id: m.id,
      name: m.name,
      encryptedValue: m.encryptedValue,
      metadata: m.metadata,
      content: m.content,
      toolCalls: toolCalls,
    );

/// A copy of [call] with the given fields replaced; a null argument keeps the
/// current value (the reducer never clears any of them).
ToolCall _toolCallWith(
  ToolCall call, {
  String? name,
  String? arguments,
  String? encryptedValue,
  Map<String, Object?>? metadata,
}) => ToolCall(
  id: call.id,
  function: FunctionCall(
    name: name ?? call.function.name,
    arguments: arguments ?? call.function.arguments,
  ),
  encryptedValue: encryptedValue ?? call.encryptedValue,
  metadata: metadata ?? call.metadata,
);

/// A structural copy of a JSON value: fresh maps and lists, shared scalars.
Object? _deepCopy(Object? value) => switch (value) {
  final Map<String, Object?> map => <String, Object?>{
    for (final entry in map.entries) entry.key: _deepCopy(entry.value),
  },
  final List<Object?> list => <Object?>[
    for (final item in list) _deepCopy(item),
  ],
  _ => value,
};

/// `JSON.stringify(value, null, 2)`, tolerating values JSON cannot encode.
String _prettyJson(Object? value) =>
    JsonEncoder.withIndent('  ', (o) => '$o').convert(value);
