/// Event type enumeration for AG-UI protocol.
library;

/// Enumeration of all AG-UI event types
enum EventType {
  textMessageStart('TEXT_MESSAGE_START'),
  textMessageContent('TEXT_MESSAGE_CONTENT'),
  textMessageEnd('TEXT_MESSAGE_END'),
  textMessageChunk('TEXT_MESSAGE_CHUNK'),
  thinkingTextMessageStart('THINKING_TEXT_MESSAGE_START'),
  thinkingTextMessageContent('THINKING_TEXT_MESSAGE_CONTENT'),
  thinkingTextMessageEnd('THINKING_TEXT_MESSAGE_END'),
  toolCallStart('TOOL_CALL_START'),
  toolCallArgs('TOOL_CALL_ARGS'),
  toolCallEnd('TOOL_CALL_END'),
  toolCallChunk('TOOL_CALL_CHUNK'),
  toolCallResult('TOOL_CALL_RESULT'),
  thinkingStart('THINKING_START'),
  thinkingContent('THINKING_CONTENT'),
  thinkingEnd('THINKING_END'),
  reasoningStart('REASONING_START'),
  reasoningEnd('REASONING_END'),
  reasoningMessageStart('REASONING_MESSAGE_START'),
  reasoningMessageContent('REASONING_MESSAGE_CONTENT'),
  reasoningMessageEnd('REASONING_MESSAGE_END'),
  reasoningMessageChunk('REASONING_MESSAGE_CHUNK'),
  reasoningEncryptedValue('REASONING_ENCRYPTED_VALUE'),
  stateSnapshot('STATE_SNAPSHOT'),
  stateDelta('STATE_DELTA'),
  messagesSnapshot('MESSAGES_SNAPSHOT'),
  activitySnapshot('ACTIVITY_SNAPSHOT'),
  activityDelta('ACTIVITY_DELTA'),
  raw('RAW'),
  custom('CUSTOM'),
  runStarted('RUN_STARTED'),
  runFinished('RUN_FINISHED'),
  runError('RUN_ERROR'),
  stepStarted('STEP_STARTED'),
  stepFinished('STEP_FINISHED');

  final String value;
  const EventType(this.value);

  static EventType fromString(String value) {
    return EventType.values.firstWhere(
      (type) => type.value == value,
      orElse: () => throw ArgumentError('Invalid event type: $value'),
    );
  }
}