## The codec's behaviour beyond what the spec fixtures pin: the receiver
## policy, null omission on the producer side, and shapes no fixture uses.

import std/[json, options, unittest]
import ag_ui_nim/core

proc strictRejects(T: typedesc, doc: string): SchemaKeyword =
  try:
    discard fromJson(parseJson(doc), T)
    raise newException(AssertionDefect, "accepted: " & doc)
  except ValidationError as e:
    e.keyword

suite "receiver policy":
  test "an unknown field is stripped with a warning instead of failing":
    var ctx = receiverContext()
    let e = fromJson(parseJson(
      """{"type":"TEXT_MESSAGE_END","messageId":"m1","somethingNewer":true}"""),
      Event, ctx)
    check e.toJson == parseJson("""{"type":"TEXT_MESSAGE_END","messageId":"m1"}""")
    check ctx.warnings == @["/somethingNewer: unknown property stripped"]

  test "an unknown field nested in a message is stripped at its own location":
    var ctx = receiverContext()
    discard fromJson(parseJson("""{"type":"MESSAGES_SNAPSHOT","messages":
      [{"id":"1","role":"user","content":"hi","mood":"ok"}]}"""), Event, ctx)
    check ctx.warnings == @["/messages/0/mood: unknown property stripped"]

  test "a deprecated whole-field null is read as absent with a warning":
    var ctx = receiverContext()
    let e = fromJson(parseJson("""{"type":"TOOL_CALL_START","toolCallId":"c1",
      "toolCallName":"search","parentMessageId":null,"subagentRunId":null}"""),
      Event, ctx)
    check e.toolCallStart.parentMessageId.isNone
    check e.toolCallStart.subagentRunId.isNone
    check ctx.warnings.len == 2

  test "a null outside the deprecation list is still rejected":
    var ctx = receiverContext()
    expect ValidationError:
      # metadata: null was never valid (DEPRECATIONS.md).
      discard fromJson(parseJson(
        """{"type":"TEXT_MESSAGE_END","messageId":"m1","metadata":null}"""),
        Event, ctx)
    expect ValidationError:
      discard fromJson(parseJson(
        """{"type":"SUBAGENT_ERROR","subagentRunId":"s","message":"x","code":null}"""),
        Event, ctx)

  test "the strict policy rejects the deprecated nulls":
    check strictRejects(Event,
      """{"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"s","parentMessageId":null}""") ==
      skType
    check strictRejects(Event,
      """{"type":"RUN_FINISHED","threadId":"t","runId":"r","result":null}""") == skNot

  test "the pre-1.0 THINKING_* events are not 1.0 events":
    check strictRejects(Event, """{"type":"THINKING_START"}""") == skOneOf
    var ctx = receiverContext()
    expect ValidationError:
      discard fromJson(parseJson("""{"type":"THINKING_TEXT_MESSAGE_CONTENT","delta":"x"}"""),
        Event, ctx)

suite "producer null omission":
  test "absent optional fields are left out, not written as null":
    let e = TextMessageStartEvent(messageId: "m1").toEvent
    check e.toJson == parseJson("""{"type":"TEXT_MESSAGE_START","messageId":"m1"}""")

  test "an optional JSON field holding null is left out":
    let e = RunFinishedEvent(threadId: "t", runId: "r",
      result: some(newJNull())).toEvent(rawEvent = some(newJNull()))
    check e.toJson == parseJson("""{"type":"RUN_FINISHED","threadId":"t","runId":"r"}""")

  test "a required JSON field keeps a null value":
    let e = CustomEvent(name: "n", value: newJNull()).toEvent
    check e.toJson == parseJson("""{"type":"CUSTOM","name":"n","value":null}""")

  test "the BaseEvent members are written when set":
    let e = StepStartedEvent(stepName: "plan", subagentRunId: some("s1")).toEvent(
      timestamp = some(1_700_000_000_000'i64), metadata = some(%*{"k": 1}))
    check e.toJson == parseJson("""{"type":"STEP_STARTED","stepName":"plan",
      "subagentRunId":"s1","timestamp":1700000000000,"metadata":{"k":1}}""")

suite "shapes the fixtures do not exercise":
  test "audio and video parts round-trip with every source kind":
    let doc = parseJson("""{"id":"u1","role":"user","content":[
      {"type":"audio","source":{"type":"data","value":"aGk=","mimeType":"audio/wav"}},
      {"type":"video","id":"v","source":{"type":"url","value":"https://example.com/v.mp4","mimeType":"video/mp4"}},
      {"type":"audio","source":{"type":"file","value":"f1","provider":"openai"},"metadata":[1]}]}""")
    let m = fromJson(doc, Message)
    check m.user.content.parts[0].kind == cptAudio
    check m.user.content.parts[1].kind == cptVideo
    check m.user.content.parts[2].media.source.kind == pstFile
    check m.toJson == doc

  test "a data source needs a mime type":
    check strictRejects(PartSource, """{"type":"data","value":"aGk="}""") == skRequired

  test "protocolVersion is carried on RUN_STARTED and in the run input":
    let doc = parseJson("""{"type":"RUN_STARTED","threadId":"t","runId":"r",
      "protocolVersion":"1.0","input":{"threadId":"t","runId":"r",
      "protocolVersion":"1.0","messages":[]}}""")
    let e = fromJson(doc, Event)
    check e.runStarted.protocolVersion == some("1.0")
    check e.runStarted.input.get.protocolVersion == some("1.0")
    check e.toJson == doc

  test "an integer written with a zero fraction is an integer":
    let usage = fromJson(parseJson("""{"inputTokens":2.0}"""), TokenUsage)
    check usage.inputTokens == some(2'i64)

  test "an integer beyond int64 or written as a large float is out of range, not mistyped":
    check strictRejects(TokenUsage, """{"inputTokens":99999999999999999999}""") == skMaximum
    check strictRejects(Event,
      """{"type":"RAW","event":1,"timestamp":-99999999999999999999}""") == skMinimum
    check strictRejects(TokenUsage, """{"inputTokens":1e30}""") == skMaximum
    check strictRejects(TokenUsage, """{"inputTokens":"12"}""") == skType

  test "TEXT_MESSAGE_START keeps an absent role absent":
    # The schema's default ("assistant") is the reader's to apply.
    let e = fromJson(parseJson("""{"type":"TEXT_MESSAGE_START","messageId":"m"}"""), Event)
    check e.textMessageStart.role.isNone

  test "a message's id is reachable whatever its role":
    let messages = [
      DeveloperMessage(id: "d", content: "").toMessage,
      SystemMessage(id: "s", content: "").toMessage,
      AssistantMessage(id: "a").toMessage,
      UserMessage(id: "u", content: textContent("")).toMessage,
      ToolMessage(id: "t", content: textContent(""), toolCallId: "c").toMessage,
      ActivityMessage(id: "ac", activityType: "x", content: newJObject()).toMessage,
      ReasoningMessage(id: "r", content: "").toMessage]
    var ids: seq[string]
    for m in messages:
      ids.add m.id
    check ids == @["d", "s", "a", "u", "t", "ac", "r"]

  test "the error names the JSON Pointer of the offending value, escaped":
    try:
      discard fromJson(parseJson("""{"custom":{"a/b":1},"identity":{"name":3}}"""),
        AgentCapabilities)
      fail()
    except ValidationError as e:
      check e.instanceLocation == "/identity/name"
      check e.keyword == skType

  test "parseEvent decodes text under the given policy":
    var ctx = receiverContext()
    let e = parseEvent("""{"type":"RAW","event":null,"x":1}""", ctx)
    check e.kind == etRaw
    check e.raw.event.kind == JNull
    check ctx.warnings.len == 1
