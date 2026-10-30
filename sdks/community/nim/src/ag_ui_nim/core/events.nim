## The 31 AG-UI 1.0 events.
##
## `Event` is an object variant over `EventType`. The `BaseEvent` members
## (`timestamp`, `rawEvent`, `metadata`) sit outside the variant; each branch
## holds the payload object named after its `$defs` entry in
## `spec/1.0/schema.json`. Events composed with `Attributable` carry an
## optional `subagentRunId`; the lifecycle and snapshot events that the schema
## does not compose with it (`MESSAGES_SNAPSHOT`, `RUN_*`, `SUBAGENT_*`) do not.
##
## The pre-1.0 `THINKING_*` events are not part of 1.0 and are not accepted.

import std/[json, options]
import ./types

export types

type
  EventType* = enum
    ## `EventType`: the discriminator of `Event`.
    etTextMessageStart = "TEXT_MESSAGE_START"
    etTextMessageContent = "TEXT_MESSAGE_CONTENT"
    etTextMessageEnd = "TEXT_MESSAGE_END"
    etTextMessageChunk = "TEXT_MESSAGE_CHUNK"
    etToolCallStart = "TOOL_CALL_START"
    etToolCallArgs = "TOOL_CALL_ARGS"
    etToolCallEnd = "TOOL_CALL_END"
    etToolCallChunk = "TOOL_CALL_CHUNK"
    etToolCallResult = "TOOL_CALL_RESULT"
    etStateSnapshot = "STATE_SNAPSHOT"
    etStateDelta = "STATE_DELTA"
    etMessagesSnapshot = "MESSAGES_SNAPSHOT"
    etActivitySnapshot = "ACTIVITY_SNAPSHOT"
    etActivityDelta = "ACTIVITY_DELTA"
    etRaw = "RAW"
    etCustom = "CUSTOM"
    etRunStarted = "RUN_STARTED"
    etRunFinished = "RUN_FINISHED"
    etRunError = "RUN_ERROR"
    etStepStarted = "STEP_STARTED"
    etStepFinished = "STEP_FINISHED"
    etReasoningStart = "REASONING_START"
    etReasoningMessageStart = "REASONING_MESSAGE_START"
    etReasoningMessageContent = "REASONING_MESSAGE_CONTENT"
    etReasoningMessageEnd = "REASONING_MESSAGE_END"
    etReasoningMessageChunk = "REASONING_MESSAGE_CHUNK"
    etReasoningEnd = "REASONING_END"
    etReasoningEncryptedValue = "REASONING_ENCRYPTED_VALUE"
    etSubagentStarted = "SUBAGENT_STARTED"
    etSubagentFinished = "SUBAGENT_FINISHED"
    etSubagentError = "SUBAGENT_ERROR"

  TextMessageStartEvent* = object
    messageId*: string
    role*: Option[TextMessageRole] ## absent means "assistant"
    name*: Option[string]
    subagentRunId* {.nullAsAbsent.}: Option[string]

  TextMessageContentEvent* = object
    messageId*: string
    delta*: string
    subagentRunId* {.nullAsAbsent.}: Option[string]

  TextMessageEndEvent* = object
    messageId*: string
    subagentRunId* {.nullAsAbsent.}: Option[string]

  TextMessageChunkEvent* = object
    messageId*: Option[string]
    role*: Option[TextMessageRole]
    delta*: Option[string]
    name*: Option[string]
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ToolCallStartEvent* = object
    toolCallId*: string
    toolCallName*: string
    parentMessageId* {.nullAsAbsent.}: Option[string]
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ToolCallArgsEvent* = object
    toolCallId*: string
    delta*: string
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ToolCallEndEvent* = object
    toolCallId*: string
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ToolCallChunkEvent* = object
    toolCallId*: Option[string]
    toolCallName*: Option[string]
    parentMessageId* {.nullAsAbsent.}: Option[string]
    delta*: Option[string]
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ToolCallResultEvent* = object
    messageId*: string
    toolCallId*: string
    content*: MessageContent
    role* {.nullAsAbsent.}: Option[ToolRole]
    subagentRunId* {.nullAsAbsent.}: Option[string]

  StateSnapshotEvent* = object
    snapshot*: JsonNode ## any JSON, including null
    subagentRunId* {.nullAsAbsent.}: Option[string]

  StateDeltaEvent* = object
    delta*: JsonPatch
    subagentRunId* {.nullAsAbsent.}: Option[string]

  MessagesSnapshotEvent* = object
    messages*: seq[Message]

  ActivitySnapshotEvent* = object
    messageId*: string
    activityType*: string
    content* {.jsonObject.}: JsonNode
    replace*: Option[bool] ## absent means true
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ActivityDeltaEvent* = object
    messageId*: string
    activityType*: string
    patch*: JsonPatch
    subagentRunId* {.nullAsAbsent.}: Option[string]

  RawEvent* = object
    event*: JsonNode ## any JSON, including null
    source*: Option[string]
    subagentRunId* {.nullAsAbsent.}: Option[string]

  CustomEvent* = object
    name*: string
    value*: JsonNode ## any JSON, including null
    subagentRunId* {.nullAsAbsent.}: Option[string]

  RunStartedEvent* = object
    threadId*: string
    runId*: string
    protocolVersion*: Option[string]
    parentRunId* {.nullAsAbsent.}: Option[string]
    input* {.nullAsAbsent.}: Option[RunAgentInput]

  RunFinishedEvent* = object
    threadId*: string
    runId*: string
    result* {.nullAsAbsent.}: Option[JsonNode] ## any JSON except a whole null
    outcome* {.nullAsAbsent.}: Option[RunFinishedOutcome]
    usage*: Option[seq[TokenUsage]]

  RunErrorEvent* = object
    message*: string
    code*: Option[string]
    usage* {.nullAsAbsent.}: Option[seq[TokenUsage]]

  StepStartedEvent* = object
    stepName*: string
    subagentRunId* {.nullAsAbsent.}: Option[string]

  StepFinishedEvent* = object
    stepName*: string
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ReasoningStartEvent* = object
    messageId*: string
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ReasoningMessageStartEvent* = object
    messageId*: string
    role*: ReasoningRole
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ReasoningMessageContentEvent* = object
    messageId*: string
    delta*: string
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ReasoningMessageEndEvent* = object
    messageId*: string
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ReasoningMessageChunkEvent* = object
    messageId*: Option[string]
    delta*: Option[string]
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ReasoningEndEvent* = object
    messageId*: string
    subagentRunId* {.nullAsAbsent.}: Option[string]

  ReasoningEncryptedValueSubtype* = enum
    revsToolCall = "tool-call"
    revsMessage = "message"

  ReasoningEncryptedValueEvent* = object
    subtype*: ReasoningEncryptedValueSubtype
    entityId*: string
    encryptedValue*: string
    subagentRunId* {.nullAsAbsent.}: Option[string]

  SubagentStartedEvent* = object
    subagentRunId*: string
    name*: string
    description*: Option[string]
    parentSubagentRunId*: Option[string]
    parentToolCallId*: Option[string]
    parentMessageId*: Option[string]

  SubagentFinishedEvent* = object
    subagentRunId*: string
    result* {.nullAsAbsent.}: Option[JsonNode] ## any JSON except a whole null
    outcome*: Option[SubagentFinishedOutcome]

  SubagentErrorEvent* = object
    subagentRunId*: string
    message*: string
    code*: Option[string]

  Event* = object
    ## `Event`: one AG-UI event.
    timestamp*: Option[int64] ## milliseconds since the Unix epoch, by convention
    rawEvent*: Option[JsonNode] ## any JSON except a whole null
    metadata*: Option[JsonNode] ## a JSON object
    case kind*: EventType
    of etTextMessageStart: textMessageStart*: TextMessageStartEvent
    of etTextMessageContent: textMessageContent*: TextMessageContentEvent
    of etTextMessageEnd: textMessageEnd*: TextMessageEndEvent
    of etTextMessageChunk: textMessageChunk*: TextMessageChunkEvent
    of etToolCallStart: toolCallStart*: ToolCallStartEvent
    of etToolCallArgs: toolCallArgs*: ToolCallArgsEvent
    of etToolCallEnd: toolCallEnd*: ToolCallEndEvent
    of etToolCallChunk: toolCallChunk*: ToolCallChunkEvent
    of etToolCallResult: toolCallResult*: ToolCallResultEvent
    of etStateSnapshot: stateSnapshot*: StateSnapshotEvent
    of etStateDelta: stateDelta*: StateDeltaEvent
    of etMessagesSnapshot: messagesSnapshot*: MessagesSnapshotEvent
    of etActivitySnapshot: activitySnapshot*: ActivitySnapshotEvent
    of etActivityDelta: activityDelta*: ActivityDeltaEvent
    of etRaw: raw*: RawEvent
    of etCustom: custom*: CustomEvent
    of etRunStarted: runStarted*: RunStartedEvent
    of etRunFinished: runFinished*: RunFinishedEvent
    of etRunError: runError*: RunErrorEvent
    of etStepStarted: stepStarted*: StepStartedEvent
    of etStepFinished: stepFinished*: StepFinishedEvent
    of etReasoningStart: reasoningStart*: ReasoningStartEvent
    of etReasoningMessageStart: reasoningMessageStart*: ReasoningMessageStartEvent
    of etReasoningMessageContent: reasoningMessageContent*: ReasoningMessageContentEvent
    of etReasoningMessageEnd: reasoningMessageEnd*: ReasoningMessageEndEvent
    of etReasoningMessageChunk: reasoningMessageChunk*: ReasoningMessageChunkEvent
    of etReasoningEnd: reasoningEnd*: ReasoningEndEvent
    of etReasoningEncryptedValue: reasoningEncryptedValue*: ReasoningEncryptedValueEvent
    of etSubagentStarted: subagentStarted*: SubagentStartedEvent
    of etSubagentFinished: subagentFinished*: SubagentFinishedEvent
    of etSubagentError: subagentError*: SubagentErrorEvent

  EventEnvelope = object
    ## The `BaseEvent` members other than `type`.
    timestamp*: Option[int64]
    rawEvent* {.nullAsAbsent.}: Option[JsonNode]
    metadata* {.jsonObject.}: Option[JsonNode]

const envelopeKeys = ["type", "timestamp", "rawEvent", "metadata"]

proc decodeValue*(n: JsonNode, path: string, ctx: var DecodeContext,
                  v: var Event) {.raises: [ValidationError].} =
  if n.kind != JObject:
    raise newValidationError(skOneOf, path, "expected an event object")
  let t = n.getOrDefault("type")
  if t.isNil or t.kind != JString:
    raise newValidationError(skOneOf, path, "missing or non-string 'type'")
  var kind = etTextMessageStart
  var found = false
  for candidate in EventType:
    if $candidate == t.getStr:
      kind = candidate
      found = true
  if not found:
    raise newValidationError(skOneOf, path,
      "unknown event type '" & t.getStr & "'")
  v = Event(kind: kind)
  case kind
  of etTextMessageStart: decodeFields(n, path, ctx, v.textMessageStart, envelopeKeys)
  of etTextMessageContent: decodeFields(n, path, ctx, v.textMessageContent, envelopeKeys)
  of etTextMessageEnd: decodeFields(n, path, ctx, v.textMessageEnd, envelopeKeys)
  of etTextMessageChunk: decodeFields(n, path, ctx, v.textMessageChunk, envelopeKeys)
  of etToolCallStart: decodeFields(n, path, ctx, v.toolCallStart, envelopeKeys)
  of etToolCallArgs: decodeFields(n, path, ctx, v.toolCallArgs, envelopeKeys)
  of etToolCallEnd: decodeFields(n, path, ctx, v.toolCallEnd, envelopeKeys)
  of etToolCallChunk: decodeFields(n, path, ctx, v.toolCallChunk, envelopeKeys)
  of etToolCallResult: decodeFields(n, path, ctx, v.toolCallResult, envelopeKeys)
  of etStateSnapshot: decodeFields(n, path, ctx, v.stateSnapshot, envelopeKeys)
  of etStateDelta: decodeFields(n, path, ctx, v.stateDelta, envelopeKeys)
  of etMessagesSnapshot: decodeFields(n, path, ctx, v.messagesSnapshot, envelopeKeys)
  of etActivitySnapshot: decodeFields(n, path, ctx, v.activitySnapshot, envelopeKeys)
  of etActivityDelta: decodeFields(n, path, ctx, v.activityDelta, envelopeKeys)
  of etRaw: decodeFields(n, path, ctx, v.raw, envelopeKeys)
  of etCustom: decodeFields(n, path, ctx, v.custom, envelopeKeys)
  of etRunStarted: decodeFields(n, path, ctx, v.runStarted, envelopeKeys)
  of etRunFinished: decodeFields(n, path, ctx, v.runFinished, envelopeKeys)
  of etRunError: decodeFields(n, path, ctx, v.runError, envelopeKeys)
  of etStepStarted: decodeFields(n, path, ctx, v.stepStarted, envelopeKeys)
  of etStepFinished: decodeFields(n, path, ctx, v.stepFinished, envelopeKeys)
  of etReasoningStart: decodeFields(n, path, ctx, v.reasoningStart, envelopeKeys)
  of etReasoningMessageStart: decodeFields(n, path, ctx, v.reasoningMessageStart, envelopeKeys)
  of etReasoningMessageContent: decodeFields(n, path, ctx, v.reasoningMessageContent, envelopeKeys)
  of etReasoningMessageEnd: decodeFields(n, path, ctx, v.reasoningMessageEnd, envelopeKeys)
  of etReasoningMessageChunk: decodeFields(n, path, ctx, v.reasoningMessageChunk, envelopeKeys)
  of etReasoningEnd: decodeFields(n, path, ctx, v.reasoningEnd, envelopeKeys)
  of etReasoningEncryptedValue: decodeFields(n, path, ctx, v.reasoningEncryptedValue, envelopeKeys)
  of etSubagentStarted: decodeFields(n, path, ctx, v.subagentStarted, envelopeKeys)
  of etSubagentFinished: decodeFields(n, path, ctx, v.subagentFinished, envelopeKeys)
  of etSubagentError: decodeFields(n, path, ctx, v.subagentError, envelopeKeys)
  var envelope: EventEnvelope
  decodeFields(n, path, ctx, envelope, checkUnknown = false)
  v.timestamp = envelope.timestamp
  v.rawEvent = envelope.rawEvent
  v.metadata = envelope.metadata

proc toJson*(v: Event): JsonNode {.raises: [].} =
  result = %*{"type": $v.kind}
  case v.kind
  of etTextMessageStart: encodeFields(v.textMessageStart, result)
  of etTextMessageContent: encodeFields(v.textMessageContent, result)
  of etTextMessageEnd: encodeFields(v.textMessageEnd, result)
  of etTextMessageChunk: encodeFields(v.textMessageChunk, result)
  of etToolCallStart: encodeFields(v.toolCallStart, result)
  of etToolCallArgs: encodeFields(v.toolCallArgs, result)
  of etToolCallEnd: encodeFields(v.toolCallEnd, result)
  of etToolCallChunk: encodeFields(v.toolCallChunk, result)
  of etToolCallResult: encodeFields(v.toolCallResult, result)
  of etStateSnapshot: encodeFields(v.stateSnapshot, result)
  of etStateDelta: encodeFields(v.stateDelta, result)
  of etMessagesSnapshot: encodeFields(v.messagesSnapshot, result)
  of etActivitySnapshot: encodeFields(v.activitySnapshot, result)
  of etActivityDelta: encodeFields(v.activityDelta, result)
  of etRaw: encodeFields(v.raw, result)
  of etCustom: encodeFields(v.custom, result)
  of etRunStarted: encodeFields(v.runStarted, result)
  of etRunFinished: encodeFields(v.runFinished, result)
  of etRunError: encodeFields(v.runError, result)
  of etStepStarted: encodeFields(v.stepStarted, result)
  of etStepFinished: encodeFields(v.stepFinished, result)
  of etReasoningStart: encodeFields(v.reasoningStart, result)
  of etReasoningMessageStart: encodeFields(v.reasoningMessageStart, result)
  of etReasoningMessageContent: encodeFields(v.reasoningMessageContent, result)
  of etReasoningMessageEnd: encodeFields(v.reasoningMessageEnd, result)
  of etReasoningMessageChunk: encodeFields(v.reasoningMessageChunk, result)
  of etReasoningEnd: encodeFields(v.reasoningEnd, result)
  of etReasoningEncryptedValue: encodeFields(v.reasoningEncryptedValue, result)
  of etSubagentStarted: encodeFields(v.subagentStarted, result)
  of etSubagentFinished: encodeFields(v.subagentFinished, result)
  of etSubagentError: encodeFields(v.subagentError, result)
  encodeFields(EventEnvelope(timestamp: v.timestamp, rawEvent: v.rawEvent,
                             metadata: v.metadata), result)

proc parseEvent*(text: string, ctx: var DecodeContext): Event {.
    raises: [ValidationError, JsonParsingError, ValueError, IOError, OSError].} =
  ## Parses one JSON-encoded event under `ctx.policy`.
  fromJson(parseJson(text), Event, ctx)

template eventPayload(P: typedesc, k: EventType, field: untyped) =
  proc toEvent*(payload: P, timestamp = none(int64),
                rawEvent = none(JsonNode), metadata = none(JsonNode)): Event {.
      raises: [].} =
    ## Wraps a payload in an `Event`, with the optional `BaseEvent` members.
    result = Event(kind: k, timestamp: timestamp, rawEvent: rawEvent,
                   metadata: metadata)
    result.field = payload

eventPayload(TextMessageStartEvent, etTextMessageStart, textMessageStart)
eventPayload(TextMessageContentEvent, etTextMessageContent, textMessageContent)
eventPayload(TextMessageEndEvent, etTextMessageEnd, textMessageEnd)
eventPayload(TextMessageChunkEvent, etTextMessageChunk, textMessageChunk)
eventPayload(ToolCallStartEvent, etToolCallStart, toolCallStart)
eventPayload(ToolCallArgsEvent, etToolCallArgs, toolCallArgs)
eventPayload(ToolCallEndEvent, etToolCallEnd, toolCallEnd)
eventPayload(ToolCallChunkEvent, etToolCallChunk, toolCallChunk)
eventPayload(ToolCallResultEvent, etToolCallResult, toolCallResult)
eventPayload(StateSnapshotEvent, etStateSnapshot, stateSnapshot)
eventPayload(StateDeltaEvent, etStateDelta, stateDelta)
eventPayload(MessagesSnapshotEvent, etMessagesSnapshot, messagesSnapshot)
eventPayload(ActivitySnapshotEvent, etActivitySnapshot, activitySnapshot)
eventPayload(ActivityDeltaEvent, etActivityDelta, activityDelta)
eventPayload(RawEvent, etRaw, raw)
eventPayload(CustomEvent, etCustom, custom)
eventPayload(RunStartedEvent, etRunStarted, runStarted)
eventPayload(RunFinishedEvent, etRunFinished, runFinished)
eventPayload(RunErrorEvent, etRunError, runError)
eventPayload(StepStartedEvent, etStepStarted, stepStarted)
eventPayload(StepFinishedEvent, etStepFinished, stepFinished)
eventPayload(ReasoningStartEvent, etReasoningStart, reasoningStart)
eventPayload(ReasoningMessageStartEvent, etReasoningMessageStart, reasoningMessageStart)
eventPayload(ReasoningMessageContentEvent, etReasoningMessageContent, reasoningMessageContent)
eventPayload(ReasoningMessageEndEvent, etReasoningMessageEnd, reasoningMessageEnd)
eventPayload(ReasoningMessageChunkEvent, etReasoningMessageChunk, reasoningMessageChunk)
eventPayload(ReasoningEndEvent, etReasoningEnd, reasoningEnd)
eventPayload(ReasoningEncryptedValueEvent, etReasoningEncryptedValue, reasoningEncryptedValue)
eventPayload(SubagentStartedEvent, etSubagentStarted, subagentStarted)
eventPayload(SubagentFinishedEvent, etSubagentFinished, subagentFinished)
eventPayload(SubagentErrorEvent, etSubagentError, subagentError)
