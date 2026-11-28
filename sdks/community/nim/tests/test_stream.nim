## Folding events into the message history and the shared state.
## The expected behaviour follows the TypeScript client's reducer
## (sdks/typescript/packages/client/src/apply/default.ts).

import std/[json, options, unittest]
import ag_ui_nim/core

proc ids(s: AgentState): seq[string] =
  for m in s.messages:
    result.add m.id

proc fold(events: varargs[Event]): AgentState =
  result = AgentState(state: newJObject())
  for e in events:
    result.applyEvent(e)

suite "text and reasoning messages":
  test "TEXT_MESSAGE_START opens an assistant message when no role is given":
    let s = fold(TextMessageStartEvent(messageId: "m1").toEvent)
    check s.messages.len == 1
    check s.messages[0].role == roleAssistant
    check s.messages[0].assistant.content == some("")

  test "TEXT_MESSAGE_START keeps the role, name and subagentRunId it was given":
    let s = fold(TextMessageStartEvent(messageId: "m1", role: some(tmrUser),
      name: some("ann"), subagentRunId: some("s1")).toEvent)
    check s.messages[0].role == roleUser
    check s.messages[0].user.name == some("ann")
    check s.messages[0].user.subagentRunId == some("s1")

  test "TEXT_MESSAGE_CONTENT appends deltas in order":
    let s = fold(
      TextMessageStartEvent(messageId: "m1", role: some(tmrSystem)).toEvent,
      TextMessageContentEvent(messageId: "m1", delta: "Hel").toEvent,
      TextMessageContentEvent(messageId: "m1", delta: "lo").toEvent,
      TextMessageEndEvent(messageId: "m1").toEvent)
    check s.messages[0].system.content == "Hello"
    check s.warnings.len == 0

  test "a second TEXT_MESSAGE_START for the same id adds nothing":
    let s = fold(TextMessageStartEvent(messageId: "m1").toEvent,
                 TextMessageStartEvent(messageId: "m1").toEvent)
    check s.messages.len == 1

  test "content for an unknown message is reported, not applied":
    let s = fold(TextMessageContentEvent(messageId: "nope", delta: "x").toEvent)
    check s.messages.len == 0
    check s.warnings.len == 1

  test "text events never write into an activity message":
    let s = fold(
      ActivitySnapshotEvent(messageId: "a1", activityType: "search",
        content: %*{"q": 1}).toEvent,
      TextMessageStartEvent(messageId: "a1").toEvent,
      TextMessageContentEvent(messageId: "a1", delta: "x").toEvent)
    check s.messages[0].activity.content == %*{"q": 1}
    check s.warnings.len == 2

  test "reasoning messages open and accumulate like text messages":
    let s = fold(
      ReasoningMessageStartEvent(messageId: "r1", subagentRunId: some("s")).toEvent,
      ReasoningMessageContentEvent(messageId: "r1", delta: "think").toEvent,
      ReasoningMessageEndEvent(messageId: "r1").toEvent)
    check s.messages[0].role == roleReasoning
    check s.messages[0].reasoning.content == "think"
    check s.messages[0].reasoning.subagentRunId == some("s")

  test "a chunk event must be expanded before it is applied":
    var s = AgentState()
    expect UnexpandedChunkError:
      s.applyEvent(TextMessageChunkEvent(delta: some("x")).toEvent)
    expect UnexpandedChunkError:
      s.applyEvent(ToolCallChunkEvent().toEvent)
    expect UnexpandedChunkError:
      s.applyEvent(ReasoningMessageChunkEvent().toEvent)

suite "tool calls":
  test "TOOL_CALL_START attaches the call to its parent assistant message":
    let s = fold(
      TextMessageStartEvent(messageId: "m1").toEvent,
      ToolCallStartEvent(toolCallId: "c1", toolCallName: "search",
        parentMessageId: some("m1")).toEvent,
      ToolCallArgsEvent(toolCallId: "c1", delta: "{\"q\":").toEvent,
      ToolCallArgsEvent(toolCallId: "c1", delta: "1}").toEvent,
      ToolCallEndEvent(toolCallId: "c1").toEvent)
    check s.messages.len == 1
    let call = s.messages[0].assistant.toolCalls.get[0]
    check call.id == "c1"
    check call.function.name == "search"
    check call.function.arguments == "{\"q\":1}"

  test "without a parent, the call opens an assistant message keyed by the call id":
    let s = fold(ToolCallStartEvent(toolCallId: "c1", toolCallName: "f").toEvent)
    check s.ids == @["c1"]
    check s.messages[0].assistant.toolCalls.get.len == 1

  test "an unknown parent id becomes the id of the new assistant message":
    let s = fold(ToolCallStartEvent(toolCallId: "c1", toolCallName: "f",
      parentMessageId: some("p9")).toEvent)
    check s.ids == @["p9"]

  test "a parent that is not an assistant message falls back to the call id":
    let s = fold(
      TextMessageStartEvent(messageId: "u1", role: some(tmrUser)).toEvent,
      ToolCallStartEvent(toolCallId: "c1", toolCallName: "f",
        parentMessageId: some("u1")).toEvent)
    check s.ids == @["u1", "c1"]
    check s.warnings.len == 1

  test "restarting a known call renames it instead of adding a second one":
    let s = fold(
      ToolCallStartEvent(toolCallId: "c1", toolCallName: "f").toEvent,
      ToolCallStartEvent(toolCallId: "c1", toolCallName: "g").toEvent)
    check s.messages.len == 1
    check s.messages[0].assistant.toolCalls.get[0].function.name == "g"

  test "args for an unknown call are reported, not applied":
    let s = fold(ToolCallArgsEvent(toolCallId: "c9", delta: "x").toEvent)
    check s.messages.len == 0
    check s.warnings.len == 1

  test "TOOL_CALL_RESULT inserts the tool message right after its call":
    let s = fold(
      ToolCallStartEvent(toolCallId: "c1", toolCallName: "f",
        parentMessageId: some("a1")).toEvent,
      TextMessageStartEvent(messageId: "m2").toEvent,
      ToolCallResultEvent(messageId: "t1", toolCallId: "c1",
        content: textContent("42")).toEvent)
    check s.ids == @["a1", "t1", "m2"]
    check s.messages[1].tool.toolCallId == "c1"
    check s.messages[1].tool.content.text == "42"

  test "a result for an unknown call is appended at the end":
    let s = fold(
      TextMessageStartEvent(messageId: "m1").toEvent,
      ToolCallResultEvent(messageId: "t1", toolCallId: "c9",
        content: textContent("x")).toEvent)
    check s.ids == @["m1", "t1"]

  test "a repeated result replaces the earlier one and keeps its other fields":
    var s = AgentState(messages: @[
      ToolMessage(id: "t1", toolCallId: "c1", content: textContent("old"),
        error: some("boom")).toMessage])
    s.applyEvent(ToolCallResultEvent(messageId: "t1", toolCallId: "c1",
      content: textContent("new")).toEvent)
    check s.messages.len == 1
    check s.messages[0].tool.content.text == "new"
    check s.messages[0].tool.error == some("boom")

suite "state":
  test "STATE_SNAPSHOT replaces the state":
    let s = fold(StateSnapshotEvent(snapshot: %*{"a": 1}).toEvent)
    check s.state == %*{"a": 1}

  test "STATE_DELTA applies a JSON Patch to the state":
    let s = fold(
      StateSnapshotEvent(snapshot: %*{"a": 1}).toEvent,
      StateDeltaEvent(delta: @[JsonPatchOperation(op: jpoAdd, path: "/b",
        value: %2)]).toEvent)
    check s.state == %*{"a": 1, "b": 2}

  test "a patch that does not apply leaves the state as it was and is reported":
    let s = fold(
      StateSnapshotEvent(snapshot: %*{"a": 1}).toEvent,
      StateDeltaEvent(delta: @[JsonPatchOperation(op: jpoRemove,
        path: "/missing")]).toEvent)
    check s.state == %*{"a": 1}
    check s.warnings.len == 1

  test "MESSAGES_SNAPSHOT replaces the history":
    let s = fold(
      TextMessageStartEvent(messageId: "m1").toEvent,
      MessagesSnapshotEvent(messages: @[
        UserMessage(id: "u1", content: textContent("hi")).toMessage]).toEvent)
    check s.ids == @["u1"]

suite "activities":
  test "ACTIVITY_SNAPSHOT creates an activity message":
    let s = fold(ActivitySnapshotEvent(messageId: "a1", activityType: "search",
      content: %*{"q": "x"}).toEvent)
    check s.messages[0].role == roleActivity
    check s.messages[0].activity.content == %*{"q": "x"}

  test "a later snapshot replaces the content unless replace is false":
    let s1 = fold(
      ActivitySnapshotEvent(messageId: "a1", activityType: "t", content: %*{"v": 1}).toEvent,
      ActivitySnapshotEvent(messageId: "a1", activityType: "t", content: %*{"v": 2}).toEvent)
    check s1.messages[0].activity.content == %*{"v": 2}
    let s2 = fold(
      ActivitySnapshotEvent(messageId: "a1", activityType: "t", content: %*{"v": 1}).toEvent,
      ActivitySnapshotEvent(messageId: "a1", activityType: "t", content: %*{"v": 2},
        replace: some(false)).toEvent)
    check s2.messages[0].activity.content == %*{"v": 1}

  test "ACTIVITY_DELTA patches the activity content":
    let s = fold(
      ActivitySnapshotEvent(messageId: "a1", activityType: "t",
        content: %*{"items": []}).toEvent,
      ActivityDeltaEvent(messageId: "a1", activityType: "t", patch: @[
        JsonPatchOperation(op: jpoAdd, path: "/items/-", value: %1)]).toEvent)
    check s.messages[0].activity.content == %*{"items": [1]}

  test "ACTIVITY_DELTA for a missing message is tolerated":
    let s = fold(ActivityDeltaEvent(messageId: "nope", activityType: "t",
      patch: @[]).toEvent)
    check s.messages.len == 0
    check s.warnings.len == 0

suite "encrypted reasoning values":
  test "REASONING_ENCRYPTED_VALUE attaches to a tool call or a message":
    let s = fold(
      ToolCallStartEvent(toolCallId: "c1", toolCallName: "f").toEvent,
      ReasoningMessageStartEvent(messageId: "r1").toEvent,
      ReasoningEncryptedValueEvent(subtype: revsToolCall, entityId: "c1",
        encryptedValue: "e1").toEvent,
      ReasoningEncryptedValueEvent(subtype: revsMessage, entityId: "r1",
        encryptedValue: "e2").toEvent)
    check s.messages[0].assistant.toolCalls.get[0].encryptedValue == some("e1")
    check s.messages[1].reasoning.encryptedValue == some("e2")
