## Folding a stream of events into the message history and the shared state.
##
## The rules follow the reducer of the TypeScript client
## (sdks/typescript/packages/client/src/apply/default.ts) for the events it
## lists below. Where that reducer warns and skips an event (content for an
## unknown message, a patch that does not apply), this one does the same and
## records the warning in `AgentState.warnings`.
##
## Not ported: merging event `metadata` into messages, the subscriber hooks,
## and the merge rules of MESSAGES_SNAPSHOT (here a snapshot replaces the
## history). Chunk events must be expanded into start/content/end events
## first; this SDK does not implement that expansion.

import std/[json, options]
import ./[types, events, patch]

type
  AgentState* = object
    messages*: seq[Message]
    state*: JsonNode
    warnings*: seq[string] ## events that were reported and skipped

  UnexpandedChunkError* = object of CatchableError
    ## A `*_CHUNK` event reached the reducer without being expanded.

proc findMessage(s: AgentState, id: string): int {.raises: [].} =
  for i, m in s.messages:
    if m.id == id:
      return i
  -1

proc toolCallIds(m: Message): seq[string] {.raises: [].} =
  if m.role == roleAssistant and m.assistant.toolCalls.isSome:
    for call in m.assistant.toolCalls.get:
      result.add call.id

proc findToolCallHolder(s: AgentState, toolCallId: string): int {.raises: [].} =
  for i, m in s.messages:
    if toolCallId in m.toolCallIds:
      return i
  -1

proc appendContent(m: var Message, delta: string) {.raises: [].} =
  ## Appends to a string content; content held as parts is replaced, as the
  ## TypeScript reducer does.
  case m.role
  of roleDeveloper: m.developer.content.add delta
  of roleSystem: m.system.content.add delta
  of roleReasoning: m.reasoning.content.add delta
  of roleAssistant: m.assistant.content = some(m.assistant.content.get("") & delta)
  of roleUser:
    let prior = if m.user.content.kind == mckText: m.user.content.text else: ""
    m.user.content = textContent(prior & delta)
  of roleTool:
    let prior = if m.tool.content.kind == mckText: m.tool.content.text else: ""
    m.tool.content = textContent(prior & delta)
  of roleActivity: discard

proc newTextMessage(e: TextMessageStartEvent): Message {.raises: [].} =
  case e.role.get(tmrAssistant)
  of tmrDeveloper:
    DeveloperMessage(id: e.messageId, content: "", name: e.name,
                     subagentRunId: e.subagentRunId).toMessage
  of tmrSystem:
    SystemMessage(id: e.messageId, content: "", name: e.name,
                  subagentRunId: e.subagentRunId).toMessage
  of tmrAssistant:
    AssistantMessage(id: e.messageId, content: some(""), name: e.name,
                     subagentRunId: e.subagentRunId).toMessage
  of tmrUser:
    UserMessage(id: e.messageId, content: textContent(""), name: e.name,
                subagentRunId: e.subagentRunId).toMessage

proc openMessage(s: var AgentState, label, id: string, created: Message) {.
    raises: [].} =
  let i = s.findMessage(id)
  if i < 0:
    s.messages.add created
  elif s.messages[i].role == roleActivity:
    s.warnings.add label & ": message '" & id & "' is an activity message"

proc appendToMessage(s: var AgentState, label, id, delta: string) {.
    raises: [].} =
  let i = s.findMessage(id)
  if i < 0:
    s.warnings.add label & ": no message with id '" & id & "'"
  elif s.messages[i].role == roleActivity:
    s.warnings.add label & ": message '" & id & "' is an activity message"
  else:
    s.messages[i].appendContent(delta)

proc checkMessageExists(s: var AgentState, label, id: string) {.raises: [].} =
  if s.findMessage(id) < 0:
    s.warnings.add label & ": no message with id '" & id & "'"

proc startToolCall(s: var AgentState, e: ToolCallStartEvent) {.raises: [].} =
  let holder = s.findToolCallHolder(e.toolCallId)
  if holder >= 0:
    for call in s.messages[holder].assistant.toolCalls.get.mitems:
      if call.id == e.toolCallId and call.function.name != e.toolCallName:
        s.warnings.add "TOOL_CALL_START: tool call '" & e.toolCallId &
          "' renamed to '" & e.toolCallName & "'"
        call.function.name = e.toolCallName
    return
  # Resolve the parent: an existing assistant message, else a new one keyed
  # by parentMessageId, or by toolCallId when there is no parent or the
  # parent id names a message of another role.
  var target = -1
  var newId = e.toolCallId
  if e.parentMessageId.isSome:
    let parent = s.findMessage(e.parentMessageId.get)
    if parent >= 0 and s.messages[parent].role == roleAssistant:
      target = parent
    elif parent >= 0:
      s.warnings.add "TOOL_CALL_START: parentMessageId '" &
        e.parentMessageId.get & "' is not an assistant message"
    else:
      newId = e.parentMessageId.get
  if target < 0:
    s.messages.add AssistantMessage(id: newId, toolCalls: some(newSeq[ToolCall]()),
                                    subagentRunId: e.subagentRunId).toMessage
    target = s.messages.high
  var calls = s.messages[target].assistant.toolCalls.get(@[])
  calls.add ToolCall(id: e.toolCallId, `type`: tctFunction,
                     function: FunctionCall(name: e.toolCallName, arguments: ""))
  s.messages[target].assistant.toolCalls = some(calls)

proc appendToolCallArgs(s: var AgentState, e: ToolCallArgsEvent) {.raises: [].} =
  let holder = s.findToolCallHolder(e.toolCallId)
  if holder < 0:
    s.warnings.add "TOOL_CALL_ARGS: no tool call with id '" & e.toolCallId & "'"
    return
  for call in s.messages[holder].assistant.toolCalls.get.mitems:
    if call.id == e.toolCallId:
      call.function.arguments.add e.delta

proc addToolResult(s: var AgentState, e: ToolCallResultEvent) {.raises: [].} =
  for m in s.messages.mitems:
    if m.role == roleTool and m.tool.id == e.messageId and
        m.tool.toolCallId == e.toolCallId:
      m.tool.content = e.content
      m.tool.subagentRunId = e.subagentRunId
      return
  let message = ToolMessage(id: e.messageId, toolCallId: e.toolCallId,
                            content: e.content,
                            subagentRunId: e.subagentRunId).toMessage
  # The owner is the newest message that issued the call and is not already
  # answered by a tool message after it; failing that, the newest issuer.
  var owner = -1
  var newestHolder = -1
  var answered = false
  for i in countdown(s.messages.high, 0):
    let m = s.messages[i]
    if m.role == roleTool and m.tool.toolCallId == e.toolCallId:
      answered = true
    elif e.toolCallId in m.toolCallIds:
      if newestHolder < 0:
        newestHolder = i
      if not answered:
        owner = i
        break
      answered = false
  if owner < 0:
    owner = newestHolder
  if owner < 0:
    s.messages.add message
    return
  var at = owner + 1
  while at < s.messages.len and s.messages[at].role in {roleTool, roleActivity}:
    inc at
  s.messages.insert(message, at)

proc applyActivitySnapshot(s: var AgentState, e: ActivitySnapshotEvent) {.
    raises: [].} =
  let created = ActivityMessage(id: e.messageId, activityType: e.activityType,
                                content: e.content.copy,
                                subagentRunId: e.subagentRunId).toMessage
  let i = s.findMessage(e.messageId)
  if i < 0:
    s.messages.add created
  elif not e.replace.get(true):
    discard # replace: false keeps whatever is there
  elif s.messages[i].role == roleActivity:
    s.messages[i].activity.activityType = e.activityType
    s.messages[i].activity.content = e.content.copy
    s.messages[i].activity.subagentRunId = e.subagentRunId
  else:
    s.messages[i] = created

proc applyActivityDelta(s: var AgentState, e: ActivityDeltaEvent) {.
    raises: [].} =
  let i = s.findMessage(e.messageId)
  if i < 0:
    return # the TypeScript client tolerates a delta with no target silently
  if s.messages[i].role != roleActivity:
    s.warnings.add "ACTIVITY_DELTA: message '" & e.messageId &
      "' is not an activity message"
    return
  try:
    let content = applyPatch(s.messages[i].activity.content, e.patch)
    s.messages[i].activity.content = content
    s.messages[i].activity.activityType = e.activityType
  except JsonPatchError as err:
    s.warnings.add "ACTIVITY_DELTA: " & err.msg

proc applyEncryptedValue(s: var AgentState, e: ReasoningEncryptedValueEvent) {.
    raises: [].} =
  case e.subtype
  of revsToolCall:
    let holder = s.findToolCallHolder(e.entityId)
    if holder >= 0:
      for call in s.messages[holder].assistant.toolCalls.get.mitems:
        if call.id == e.entityId:
          call.encryptedValue = some(e.encryptedValue)
  of revsMessage:
    let i = s.findMessage(e.entityId)
    if i >= 0:
      let value = some(e.encryptedValue)
      case s.messages[i].role
      of roleDeveloper: s.messages[i].developer.encryptedValue = value
      of roleSystem: s.messages[i].system.encryptedValue = value
      of roleAssistant: s.messages[i].assistant.encryptedValue = value
      of roleUser: s.messages[i].user.encryptedValue = value
      of roleTool: s.messages[i].tool.encryptedValue = value
      of roleReasoning: s.messages[i].reasoning.encryptedValue = value
      of roleActivity: discard # activity messages carry no encrypted value

proc applyEvent*(s: var AgentState, event: Event) {.
    raises: [UnexpandedChunkError].} =
  ## Applies one event to `s`.
  case event.kind
  of etTextMessageStart:
    let e = event.textMessageStart
    s.openMessage("TEXT_MESSAGE_START", e.messageId, newTextMessage(e))
  of etTextMessageContent:
    let e = event.textMessageContent
    s.appendToMessage("TEXT_MESSAGE_CONTENT", e.messageId, e.delta)
  of etTextMessageEnd:
    s.checkMessageExists("TEXT_MESSAGE_END", event.textMessageEnd.messageId)
  of etReasoningMessageStart:
    let e = event.reasoningMessageStart
    s.openMessage("REASONING_MESSAGE_START", e.messageId,
      ReasoningMessage(id: e.messageId, content: "",
                       subagentRunId: e.subagentRunId).toMessage)
  of etReasoningMessageContent:
    let e = event.reasoningMessageContent
    s.appendToMessage("REASONING_MESSAGE_CONTENT", e.messageId, e.delta)
  of etReasoningMessageEnd:
    s.checkMessageExists("REASONING_MESSAGE_END",
                         event.reasoningMessageEnd.messageId)
  of etReasoningEncryptedValue:
    s.applyEncryptedValue(event.reasoningEncryptedValue)
  of etToolCallStart:
    s.startToolCall(event.toolCallStart)
  of etToolCallArgs:
    s.appendToolCallArgs(event.toolCallArgs)
  of etToolCallEnd:
    if s.findToolCallHolder(event.toolCallEnd.toolCallId) < 0:
      s.warnings.add "TOOL_CALL_END: no tool call with id '" &
        event.toolCallEnd.toolCallId & "'"
  of etToolCallResult:
    s.addToolResult(event.toolCallResult)
  of etStateSnapshot:
    s.state = event.stateSnapshot.snapshot.copy
  of etStateDelta:
    try:
      s.state = applyPatch(s.state, event.stateDelta.delta)
    except JsonPatchError as err:
      s.warnings.add "STATE_DELTA: " & err.msg
  of etMessagesSnapshot:
    s.messages = event.messagesSnapshot.messages
  of etActivitySnapshot:
    s.applyActivitySnapshot(event.activitySnapshot)
  of etActivityDelta:
    s.applyActivityDelta(event.activityDelta)
  of etTextMessageChunk, etToolCallChunk, etReasoningMessageChunk:
    raise newException(UnexpandedChunkError,
      $event.kind & " must be expanded into start/content/end events before it is applied")
  of etRaw, etCustom, etRunStarted, etRunFinished, etRunError, etStepStarted,
     etStepFinished, etReasoningStart, etReasoningEnd, etSubagentStarted,
     etSubagentFinished, etSubagentError:
    discard # these change neither the history nor the state

proc applyEvents*(s: var AgentState, events: openArray[Event]) {.
    raises: [UnexpandedChunkError].} =
  for event in events:
    s.applyEvent(event)
