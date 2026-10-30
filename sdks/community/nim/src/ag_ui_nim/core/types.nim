## The AG-UI 1.0 data types other than events and capabilities:
## messages, content parts and their sources, tools, the run input, resume
## entries, interrupts, token usage, run outcomes and JSON Patch operations.
##
## Each object mirrors the `$defs` entry of the same name in
## `spec/1.0/schema.json`; field names are the wire names. A union (`oneOf`)
## is an object variant over its discriminator, and the discriminator itself
## is not repeated inside the branch payload.

import std/[json, options]
import ./codec

export codec

type
  Role* = enum
    ## `Role`: the discriminator of `Message`.
    roleDeveloper = "developer"
    roleSystem = "system"
    roleAssistant = "assistant"
    roleUser = "user"
    roleTool = "tool"
    roleActivity = "activity"
    roleReasoning = "reasoning"

  TextMessageRole* = enum
    ## `TextMessageRole`: the roles a text message stream can carry.
    tmrDeveloper = "developer"
    tmrSystem = "system"
    tmrAssistant = "assistant"
    tmrUser = "user"

  ToolRole* = enum
    ## The `const: "tool"` role of `TOOL_CALL_RESULT`.
    toolRole = "tool"

  ReasoningRole* = enum
    ## The `const: "reasoning"` role of `REASONING_MESSAGE_START`.
    reasoningRole = "reasoning"

  ToolCallType* = enum
    ## The `const: "function"` type of `ToolCall`.
    tctFunction = "function"

  FunctionCall* = object
    name*: string
    arguments*: string ## the arguments as a JSON-encoded string

  ToolCall* = object
    id*: string
    `type`*: ToolCallType
    function*: FunctionCall
    encryptedValue*: Option[string]
    metadata* {.jsonObject.}: Option[JsonNode]

  PartSourceType* = enum
    pstData = "data"
    pstUrl = "url"
    pstFile = "file"

  DataSource* = object
    value*: string ## base64
    mimeType*: string

  UrlSource* = object
    value*: string
    mimeType*: Option[string]

  FileSource* = object
    value*: string
    provider*: Option[string]
    mimeType*: Option[string]

  PartSource* = object
    ## `PartSource`: where a media part's bytes are.
    case kind*: PartSourceType
    of pstData: data*: DataSource
    of pstUrl: url*: UrlSource
    of pstFile: file*: FileSource

  ContentPartType* = enum
    cptText = "text"
    cptImage = "image"
    cptAudio = "audio"
    cptVideo = "video"
    cptDocument = "document"

  TextPart* = object
    id*: Option[string]
    text*: string
    metadata*: Option[JsonNode] ## any JSON except a whole null

  MediaPart* = object
    ## The shared shape of `ImagePart`, `AudioPart`, `VideoPart` and
    ## `DocumentPart`; the branch of `ContentPart` says which one it is.
    id*: Option[string]
    source*: PartSource
    metadata* {.nullAsAbsent.}: Option[JsonNode] ## any JSON except a whole null

  ImagePart* = MediaPart
  AudioPart* = MediaPart
  VideoPart* = MediaPart
  DocumentPart* = MediaPart

  ContentPart* = object
    ## `ContentPart`: one part of a multimodal message.
    case kind*: ContentPartType
    of cptText: text*: TextPart
    of cptImage, cptAudio, cptVideo, cptDocument: media*: MediaPart

  MessageContentKind* = enum
    mckText  ## a plain string
    mckParts ## an array of `ContentPart`

  MessageContent* = object
    ## `string | ContentPart[]`, the content of a user or tool message and of
    ## `TOOL_CALL_RESULT`.
    case kind*: MessageContentKind
    of mckText: text*: string
    of mckParts: parts*: seq[ContentPart]

  DeveloperMessage* = object
    id*: string
    content*: string
    name*: Option[string]
    encryptedValue*: Option[string]
    metadata* {.jsonObject.}: Option[JsonNode]
    subagentRunId*: Option[string]

  SystemMessage* = object
    id*: string
    content*: string
    name*: Option[string]
    encryptedValue*: Option[string]
    metadata* {.jsonObject.}: Option[JsonNode]
    subagentRunId*: Option[string]

  AssistantMessage* = object
    id*: string
    content*: Option[string]
    toolCalls*: Option[seq[ToolCall]]
    name*: Option[string]
    encryptedValue*: Option[string]
    metadata* {.jsonObject.}: Option[JsonNode]
    subagentRunId*: Option[string]

  UserMessage* = object
    id*: string
    content*: MessageContent
    name*: Option[string]
    encryptedValue*: Option[string]
    metadata* {.jsonObject.}: Option[JsonNode]
    subagentRunId*: Option[string]

  ToolMessage* = object
    id*: string
    content*: MessageContent
    toolCallId*: string
    error*: Option[string]
    encryptedValue*: Option[string]
    metadata* {.jsonObject.}: Option[JsonNode]
    subagentRunId*: Option[string]

  ActivityMessage* = object
    id*: string
    activityType*: string
    content* {.jsonObject.}: JsonNode
    metadata* {.jsonObject.}: Option[JsonNode]
    subagentRunId*: Option[string]

  ReasoningMessage* = object
    id*: string
    content*: string
    encryptedValue*: Option[string]
    metadata* {.jsonObject.}: Option[JsonNode]
    subagentRunId*: Option[string]

  Message* = object
    ## `Message`: one entry of the conversation history.
    case role*: Role
    of roleDeveloper: developer*: DeveloperMessage
    of roleSystem: system*: SystemMessage
    of roleAssistant: assistant*: AssistantMessage
    of roleUser: user*: UserMessage
    of roleTool: tool*: ToolMessage
    of roleActivity: activity*: ActivityMessage
    of roleReasoning: reasoning*: ReasoningMessage

  Context* = object
    description*: string
    value*: string

  Tool* = object
    name*: string
    description*: string
    parameters* {.nullAsAbsent.}: Option[JsonNode] ## a JSON Schema, by convention
    metadata* {.jsonObject.}: Option[JsonNode]

  ResumeStatus* = enum
    rsResolved = "resolved"
    rsCancelled = "cancelled"

  ResumeEntry* = object
    interruptId*: string
    status*: ResumeStatus
    payload* {.nullAsAbsent.}: Option[JsonNode]
    metadata* {.jsonObject.}: Option[JsonNode]

  Interrupt* = object
    id*: string
    reason*: string
    message*: Option[string]
    toolCallId*: Option[string]
    responseSchema* {.jsonObject.}: Option[JsonNode]
    expiresAt*: Option[string]
    metadata* {.jsonObject.}: Option[JsonNode]
    subagentRunId*: Option[string]

  TokenUsage* = object
    provider* {.nullAsAbsent.}: Option[string]
    model*: Option[string]
    inputTokens* {.nonNegative.}: Option[int64]
    outputTokens* {.nonNegative.}: Option[int64]
    totalTokens* {.nonNegative.}: Option[int64]
    reasoningTokens* {.nonNegative, nullAsAbsent.}: Option[int64]
    cachedInputTokens* {.nonNegative, nullAsAbsent.}: Option[int64]
    cacheWriteInputTokens* {.nonNegative, nullAsAbsent.}: Option[int64]

  RunFinishedOutcomeType* = enum
    rfoSuccess = "success"
    rfoInterrupt = "interrupt"
    rfoCancelled = "cancelled"

  RunFinishedSuccessOutcome* = object
    pendingToolCallIds* {.nullAsAbsent.}: Option[seq[string]]

  RunFinishedInterruptOutcome* = object
    interrupts*: seq[Interrupt] ## at least one

  RunFinishedCancelledOutcome* = object

  RunFinishedOutcome* = object
    ## `RunFinishedOutcome`: how a run ended.
    case kind*: RunFinishedOutcomeType
    of rfoSuccess: success*: RunFinishedSuccessOutcome
    of rfoInterrupt: interrupt*: RunFinishedInterruptOutcome
    of rfoCancelled: cancelled*: RunFinishedCancelledOutcome

  SubagentFinishedOutcomeType* = enum
    sfoSuccess = "success"
    sfoSuspended = "suspended"

  SubagentFinishedSuccessOutcome* = object

  SubagentFinishedSuspendedOutcome* = object
    interruptIds*: Option[seq[string]]

  SubagentFinishedOutcome* = object
    ## `SubagentFinishedOutcome`: how a subagent run ended.
    case kind*: SubagentFinishedOutcomeType
    of sfoSuccess: success*: SubagentFinishedSuccessOutcome
    of sfoSuspended: suspended*: SubagentFinishedSuspendedOutcome

  JsonPatchOp* = enum
    jpoAdd = "add"
    jpoRemove = "remove"
    jpoReplace = "replace"
    jpoMove = "move"
    jpoCopy = "copy"
    jpoTest = "test"

  JsonPatchOperation* = object
    ## One RFC 6902 operation (`AddOperation` ... `TestOperation`).
    path*: string ## a JSON Pointer
    case op*: JsonPatchOp
    of jpoAdd, jpoReplace, jpoTest: value*: JsonNode
    of jpoMove, jpoCopy: `from`*: string ## a JSON Pointer
    of jpoRemove: discard

  JsonPatch* = seq[JsonPatchOperation]

  RunAgentInput* = object
    ## `RunAgentInput`: the body of a run request.
    threadId*: string
    runId*: string
    messages*: seq[Message]
    protocolVersion*: Option[string]
    parentRunId*: Option[string]
    state* {.nullAsAbsent.}: Option[JsonNode]
    tools*: Option[seq[Tool]]
    context*: Option[seq[Context]]
    forwardedProps* {.nullAsAbsent.}: Option[JsonNode]
    resume*: Option[seq[ResumeEntry]]

# ---------------------------------------------------------------------------
# Codecs, leaves first: a generic codec resolves `decodeValue`/`toJson` for
# nested types at the point it is instantiated.

proc discriminator(n: JsonNode, path, key: string): string {.
    raises: [ValidationError].} =
  ## The string discriminator of a union member; anything else matches no
  ## branch, which the schema reports as `oneOf` at the member.
  if n.kind != JObject:
    raise newValidationError(skOneOf, path, "expected an object")
  let d = n.getOrDefault(key)
  if d.isNil or d.kind != JString:
    raise newValidationError(skOneOf, path, "missing or non-string '" & key & "'")
  d.getStr

proc noBranch(path, key, value: string): ref ValidationError {.raises: [].} =
  newValidationError(skOneOf, path, "no variant has " & key & " '" & value & "'")

objectCodec(FunctionCall)
objectCodec(ToolCall)
objectCodec(DataSource)
objectCodec(UrlSource)
objectCodec(FileSource)

proc decodeValue*(n: JsonNode, path: string, ctx: var DecodeContext,
                  v: var PartSource) {.raises: [ValidationError].} =
  let t = discriminator(n, path, "type")
  case t
  of "data":
    v = PartSource(kind: pstData)
    decodeFields(n, path, ctx, v.data, ["type"])
  of "url":
    v = PartSource(kind: pstUrl)
    decodeFields(n, path, ctx, v.url, ["type"])
  of "file":
    v = PartSource(kind: pstFile)
    decodeFields(n, path, ctx, v.file, ["type"])
  else:
    raise noBranch(path, "type", t)

proc toJson*(v: PartSource): JsonNode {.raises: [].} =
  result = %*{"type": $v.kind}
  case v.kind
  of pstData: encodeFields(v.data, result)
  of pstUrl: encodeFields(v.url, result)
  of pstFile: encodeFields(v.file, result)

objectCodec(TextPart)
objectCodec(MediaPart)

proc decodeValue*(n: JsonNode, path: string, ctx: var DecodeContext,
                  v: var ContentPart) {.raises: [ValidationError].} =
  let t = discriminator(n, path, "type")
  case t
  of "text":
    v = ContentPart(kind: cptText)
    decodeFields(n, path, ctx, v.text, ["type"])
  of "image", "audio", "video", "document":
    let kind =
      case t
      of "image": cptImage
      of "audio": cptAudio
      of "video": cptVideo
      else: cptDocument
    v = ContentPart(kind: kind)
    decodeFields(n, path, ctx, v.media, ["type"])
  else:
    raise noBranch(path, "type", t)

proc toJson*(v: ContentPart): JsonNode {.raises: [].} =
  result = %*{"type": $v.kind}
  case v.kind
  of cptText: encodeFields(v.text, result)
  of cptImage, cptAudio, cptVideo, cptDocument: encodeFields(v.media, result)

proc decodeValue*(n: JsonNode, path: string, ctx: var DecodeContext,
                  v: var MessageContent) {.raises: [ValidationError].} =
  case n.kind
  of JString:
    v = MessageContent(kind: mckText, text: n.getStr)
  of JArray:
    v = MessageContent(kind: mckParts)
    decodeAny(n, path, ctx, v.parts)
  else:
    raise newValidationError(skOneOf, path,
      "expected a string or an array of content parts")

proc toJson*(v: MessageContent): JsonNode {.raises: [].} =
  case v.kind
  of mckText: newJString(v.text)
  of mckParts: encodeAny(v.parts)

proc textContent*(text: string): MessageContent {.raises: [].} =
  MessageContent(kind: mckText, text: text)

proc partsContent*(parts: openArray[ContentPart]): MessageContent {.raises: [].} =
  MessageContent(kind: mckParts, parts: @parts)

proc decodeValue*(n: JsonNode, path: string, ctx: var DecodeContext,
                  v: var Message) {.raises: [ValidationError].} =
  let r = discriminator(n, path, "role")
  case r
  of "developer":
    v = Message(role: roleDeveloper)
    decodeFields(n, path, ctx, v.developer, ["role"])
  of "system":
    v = Message(role: roleSystem)
    decodeFields(n, path, ctx, v.system, ["role"])
  of "assistant":
    v = Message(role: roleAssistant)
    decodeFields(n, path, ctx, v.assistant, ["role"])
  of "user":
    v = Message(role: roleUser)
    decodeFields(n, path, ctx, v.user, ["role"])
  of "tool":
    v = Message(role: roleTool)
    decodeFields(n, path, ctx, v.tool, ["role"])
  of "activity":
    v = Message(role: roleActivity)
    decodeFields(n, path, ctx, v.activity, ["role"])
  of "reasoning":
    v = Message(role: roleReasoning)
    decodeFields(n, path, ctx, v.reasoning, ["role"])
  else:
    raise noBranch(path, "role", r)

proc toJson*(v: Message): JsonNode {.raises: [].} =
  result = %*{"role": $v.role}
  case v.role
  of roleDeveloper: encodeFields(v.developer, result)
  of roleSystem: encodeFields(v.system, result)
  of roleAssistant: encodeFields(v.assistant, result)
  of roleUser: encodeFields(v.user, result)
  of roleTool: encodeFields(v.tool, result)
  of roleActivity: encodeFields(v.activity, result)
  of roleReasoning: encodeFields(v.reasoning, result)

proc toMessage*(m: DeveloperMessage): Message {.raises: [].} =
  Message(role: roleDeveloper, developer: m)
proc toMessage*(m: SystemMessage): Message {.raises: [].} =
  Message(role: roleSystem, system: m)
proc toMessage*(m: AssistantMessage): Message {.raises: [].} =
  Message(role: roleAssistant, assistant: m)
proc toMessage*(m: UserMessage): Message {.raises: [].} =
  Message(role: roleUser, user: m)
proc toMessage*(m: ToolMessage): Message {.raises: [].} =
  Message(role: roleTool, tool: m)
proc toMessage*(m: ActivityMessage): Message {.raises: [].} =
  Message(role: roleActivity, activity: m)
proc toMessage*(m: ReasoningMessage): Message {.raises: [].} =
  Message(role: roleReasoning, reasoning: m)

proc id*(m: Message): string {.raises: [].} =
  ## The `id` every message carries.
  case m.role
  of roleDeveloper: m.developer.id
  of roleSystem: m.system.id
  of roleAssistant: m.assistant.id
  of roleUser: m.user.id
  of roleTool: m.tool.id
  of roleActivity: m.activity.id
  of roleReasoning: m.reasoning.id

objectCodec(Context)
objectCodec(Tool)
objectCodec(ResumeEntry)
objectCodec(Interrupt)
objectCodec(TokenUsage)
objectCodec(RunFinishedSuccessOutcome)
objectCodec(RunFinishedCancelledOutcome)
objectCodec(SubagentFinishedSuccessOutcome)
objectCodec(SubagentFinishedSuspendedOutcome)

proc decodeValue*(n: JsonNode, path: string, ctx: var DecodeContext,
                  v: var RunFinishedInterruptOutcome) {.
    raises: [ValidationError].} =
  decodeFields(n, path, ctx, v, ["type"])
  if v.interrupts.len == 0:
    raise newValidationError(skMinItems, childPointer(path, "interrupts"),
      "an interrupt outcome needs at least one interrupt")

proc decodeValue*(n: JsonNode, path: string, ctx: var DecodeContext,
                  v: var RunFinishedOutcome) {.raises: [ValidationError].} =
  let t = discriminator(n, path, "type")
  case t
  of "success":
    v = RunFinishedOutcome(kind: rfoSuccess)
    decodeFields(n, path, ctx, v.success, ["type"])
  of "interrupt":
    v = RunFinishedOutcome(kind: rfoInterrupt)
    decodeValue(n, path, ctx, v.interrupt)
  of "cancelled":
    v = RunFinishedOutcome(kind: rfoCancelled)
    decodeFields(n, path, ctx, v.cancelled, ["type"])
  else:
    raise noBranch(path, "type", t)

proc toJson*(v: RunFinishedOutcome): JsonNode {.raises: [].} =
  result = %*{"type": $v.kind}
  case v.kind
  of rfoSuccess: encodeFields(v.success, result)
  of rfoInterrupt: encodeFields(v.interrupt, result)
  of rfoCancelled: encodeFields(v.cancelled, result)

proc decodeValue*(n: JsonNode, path: string, ctx: var DecodeContext,
                  v: var SubagentFinishedOutcome) {.raises: [ValidationError].} =
  let t = discriminator(n, path, "type")
  case t
  of "success":
    v = SubagentFinishedOutcome(kind: sfoSuccess)
    decodeFields(n, path, ctx, v.success, ["type"])
  of "suspended":
    v = SubagentFinishedOutcome(kind: sfoSuspended)
    decodeFields(n, path, ctx, v.suspended, ["type"])
  else:
    raise noBranch(path, "type", t)

proc toJson*(v: SubagentFinishedOutcome): JsonNode {.raises: [].} =
  result = %*{"type": $v.kind}
  case v.kind
  of sfoSuccess: encodeFields(v.success, result)
  of sfoSuspended: encodeFields(v.suspended, result)

proc decodePointer(n: JsonNode, path, key: string): string {.
    raises: [ValidationError].} =
  let child = childPointer(path, key)
  let p = n.getOrDefault(key)
  if p.kind != JString:
    raise newValidationError(skType, child, "expected a string")
  result = p.getStr
  if not isJsonPointer(result):
    raise newValidationError(skPattern, child, "not a JSON Pointer")

proc decodeValue*(n: JsonNode, path: string, ctx: var DecodeContext,
                  v: var JsonPatchOperation) {.raises: [ValidationError].} =
  ## RFC 6902 operations are open: members an operation does not define are
  ## ignored, as the RFC requires (the schema leaves these objects open).
  if n.kind != JObject:
    raise newValidationError(skOneOf, path, "expected an object")
  for key in ["op", "path"]:
    if not n.hasKey(key):
      raise newValidationError(skRequired, path,
        "missing required property '" & key & "'")
  let opNode = n.getOrDefault("op")
  var op = jpoAdd
  var known = false
  for candidate in JsonPatchOp:
    if opNode.kind == JString and opNode.getStr == $candidate:
      op = candidate
      known = true
  if not known:
    # Each branch pins `op` with `const`; the schema reports that rule.
    raise newValidationError(skConst, childPointer(path, "op"),
      "unknown JSON Patch operation " & $opNode)
  let required =
    case op
    of jpoAdd, jpoReplace, jpoTest: "value"
    of jpoMove, jpoCopy: "from"
    of jpoRemove: ""
  if required.len > 0 and not n.hasKey(required):
    raise newValidationError(skRequired, path,
      "missing required property '" & required & "'")
  v = JsonPatchOperation(op: op, path: decodePointer(n, path, "path"))
  case op
  of jpoAdd, jpoReplace, jpoTest:
    v.value = n.getOrDefault("value").copy
  of jpoMove, jpoCopy:
    v.`from` = decodePointer(n, path, "from")
  of jpoRemove:
    discard

proc toJson*(v: JsonPatchOperation): JsonNode {.raises: [].} =
  result = %*{"op": $v.op}
  case v.op
  of jpoMove, jpoCopy: result["from"] = newJString(v.`from`)
  else: discard
  result["path"] = newJString(v.path)
  case v.op
  of jpoAdd, jpoReplace, jpoTest: result["value"] = encodeAny(v.value)
  else: discard

objectCodec(RunAgentInput)
