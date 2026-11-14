//! This integration test compiles as a downstream crate: protocol records cannot
//! be constructed with struct literals here.
use ag_ui_core::{event::*, types::*};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

fn assert_wire<T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug>(
    value: T,
    expected: Value,
) {
    assert_eq!(serde_json::to_value(&value).unwrap(), expected);
    assert_eq!(serde_json::from_value::<T>(expected).unwrap(), value);
}

#[test]
fn every_event_has_a_downstream_construction_path() {
    assert_wire(BaseEvent::default(), json!({}));
    assert_wire(
        TextMessageStartEvent::new("message"),
        json!({"messageId": "message", "role": "assistant"}),
    );
    assert_wire(
        TextMessageContentEvent::new("message", "text".into()).unwrap(),
        json!({"messageId": "message", "delta": "text"}),
    );
    assert_wire(
        TextMessageEndEvent::new("message"),
        json!({"messageId": "message"}),
    );
    assert_wire(TextMessageChunkEvent::default(), json!({}));
    assert_wire(ThinkingTextMessageStartEvent::default(), json!({}));
    assert_wire(
        ThinkingTextMessageContentEvent::new("text".into()),
        json!({"delta": "text"}),
    );
    assert_wire(ThinkingTextMessageEndEvent::default(), json!({}));
    assert_wire(
        ToolCallStartEvent::new("call", "text".into()),
        json!({"toolCallId": "call", "toolCallName": "text"}),
    );
    assert_wire(
        ToolCallArgsEvent::new("call", "text".into()),
        json!({"toolCallId": "call", "delta": "text"}),
    );
    assert_wire(ToolCallEndEvent::new("call"), json!({"toolCallId": "call"}));
    assert_wire(
        ToolCallResultEvent::new("message", "call", MessageContent::Text("text".into())),
        json!({"messageId": "message", "toolCallId": "call", "content": "text"}),
    );
    assert_wire(ToolCallChunkEvent::default(), json!({}));
    assert_wire(ThinkingStartEvent::default(), json!({}));
    assert_wire(ThinkingEndEvent::default(), json!({}));
    assert_wire(
        StateSnapshotEvent::new(json!({"state": true})),
        json!({"snapshot": {"state": true}}),
    );
    assert_wire(StateDeltaEvent::new(vec![]), json!({"delta": []}));
    assert_wire(MessagesSnapshotEvent::new(vec![]), json!({"messages": []}));
    assert_wire(
        RawEvent::new(json!({"ok": true})),
        json!({"event": {"ok": true}}),
    );
    assert_wire(
        CustomEvent::new("text".into(), json!({"ok": true})),
        json!({"name": "text", "value": {"ok": true}}),
    );
    assert_wire(
        RunStartedEvent::new("thread", "run"),
        json!({"threadId": "thread", "runId": "run"}),
    );
    assert_wire(
        RunFinishedEvent::new("thread", "run"),
        json!({"threadId": "thread", "runId": "run"}),
    );
    assert_wire(
        RunErrorEvent::new("text".into()),
        json!({"message": "text"}),
    );
    assert_wire(
        StepStartedEvent::new("text".into()),
        json!({"stepName": "text"}),
    );
    assert_wire(
        StepFinishedEvent::new("text".into()),
        json!({"stepName": "text"}),
    );
    assert_wire(
        ActivitySnapshotEvent::new("message", "text".into(), serde_json::Map::new()),
        json!({"messageId": "message", "activityType": "text", "content": {}}),
    );
    assert_wire(
        ActivityDeltaEvent::new("message", "text".into(), vec![]),
        json!({"messageId": "message", "activityType": "text", "patch": []}),
    );
    assert_wire(
        ReasoningStartEvent::new("message"),
        json!({"messageId": "message"}),
    );
    assert_wire(
        ReasoningMessageStartEvent::new("message"),
        json!({"messageId": "message", "role": "reasoning"}),
    );
    assert_wire(
        ReasoningMessageContentEvent::new("message", "text".into()),
        json!({"messageId": "message", "delta": "text"}),
    );
    assert_wire(
        ReasoningMessageEndEvent::new("message"),
        json!({"messageId": "message"}),
    );
    assert_wire(ReasoningMessageChunkEvent::default(), json!({}));
    assert_wire(
        ReasoningEndEvent::new("message"),
        json!({"messageId": "message"}),
    );
    assert_wire(
        ReasoningEncryptedValueEvent::new(
            ReasoningEncryptedValueSubtype::Message,
            "text".into(),
            "text".into(),
        ),
        json!({"subtype": "message", "entityId": "text", "encryptedValue": "text"}),
    );
    assert_wire(
        SubagentStartedEvent::new("text".into(), "text".into()),
        json!({"subagentRunId": "text", "name": "text"}),
    );
    assert_wire(
        SubagentFinishedEvent::new("text".into()),
        json!({"subagentRunId": "text"}),
    );
    assert_wire(
        SubagentErrorEvent::new("text".into(), "text".into()),
        json!({"subagentRunId": "text", "message": "text"}),
    );
}

#[test]
fn nested_payloads_and_message_records_are_constructible() {
    assert_wire(
        FunctionCall::new("lookup".into(), "{}".into()),
        json!({"name": "lookup", "arguments": "{}"}),
    );
    assert_wire(
        Context::new("location".into(), "Paris".into()),
        json!({"description": "location", "value": "Paris"}),
    );
    assert_wire(
        Tool::new("lookup".into(), "Find a record".into(), json!({})),
        json!({"name": "lookup", "description": "Find a record", "parameters": {}}),
    );
    assert_wire(
        ToolCall::new("call", FunctionCall::new("lookup".into(), "{}".into())),
        json!({"id": "call", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}),
    );
    assert_wire(
        BaseMessage::new("m", Role::User),
        json!({"id": "m", "role": "user"}),
    );
    assert_wire(
        DeveloperMessage::new("m", "text".into()),
        json!({"id": "m", "role": "developer", "content": "text"}),
    );
    assert_wire(
        SystemMessage::new("m", "text".into()),
        json!({"id": "m", "role": "system", "content": "text"}),
    );
    assert_wire(
        AssistantMessage::new("m"),
        json!({"id": "m", "role": "assistant"}),
    );
    assert_wire(
        UserMessage::new("m", "text".into()),
        json!({"id": "m", "role": "user", "content": "text"}),
    );
    assert_wire(
        ToolMessage::new("m", "text".into(), "call"),
        json!({"id": "m", "role": "tool", "content": "text", "toolCallId": "call"}),
    );
    assert_wire(
        ReasoningMessage::new("m", "text".into()),
        json!({"id": "m", "role": "reasoning", "content": "text"}),
    );
    assert_wire(
        ActivityMessage::new("m", "plan".into(), serde_json::Map::new()),
        json!({"id": "m", "activityType": "plan", "content": {}}),
    );
    assert_wire(
        Interrupt::new("approval".into(), "permission".into()),
        json!({"id": "approval", "reason": "permission"}),
    );
    assert_wire(
        ResumeEntry::new("approval".into(), ResumeStatus::Resolved),
        json!({"interruptId": "approval", "status": "resolved"}),
    );
    assert_wire(
        SubagentInfo::new("research".into()),
        json!({"name": "research"}),
    );
    assert_wire(
        RunAgentInput::new(
            "thread",
            "run",
            json!({}),
            vec![],
            vec![],
            vec![],
            json!({}),
        ),
        json!({"threadId": "thread", "runId": "run", "state": {}, "messages": [], "tools": [], "context": [], "forwardedProps": {}}),
    );
}

#[test]
fn optional_payloads_start_empty_and_remain_mutable() {
    assert_wire(TokenUsage::default(), json!({}));
    assert_wire(AgentCapabilities::default(), json!({}));
    assert_wire(ExecutionCapabilities::default(), json!({}));
    assert_wire(IdentityCapabilities::default(), json!({}));
    assert_wire(TransportCapabilities::default(), json!({}));
    assert_wire(ToolsCapabilities::default(), json!({}));
    assert_wire(OutputCapabilities::default(), json!({}));
    assert_wire(StateCapabilities::default(), json!({}));
    assert_wire(MultiAgentCapabilities::default(), json!({}));
    assert_wire(ReasoningCapabilities::default(), json!({}));
    assert_wire(MultimodalInputCapabilities::default(), json!({}));
    assert_wire(MultimodalOutputCapabilities::default(), json!({}));
    assert_wire(MultimodalCapabilities::default(), json!({}));
    assert_wire(HumanInTheLoopCapabilities::default(), json!({}));

    let mut usage = TokenUsage::default();
    usage.total_tokens = Some(12);
    let mut base = BaseEvent::default();
    base.timestamp = Some(123);
    base.metadata = Some(serde_json::Map::from_iter([(
        "source".into(),
        json!("test"),
    )]));
    let mut event = RunFinishedEvent::new("thread", "run").with_base(base);
    event.result = Some(json!({"answer": 42}));
    event.usage = Some(vec![usage]);
    assert_wire(
        event,
        json!({"threadId": "thread", "runId": "run", "timestamp": 123, "metadata": {"source": "test"}, "result": {"answer": 42}, "usage": [{"totalTokens": 12}]}),
    );
}
