//! Snapshots of the serialized wire format.
//!
//! These pin the exact JSON a representative run produces, so a change to a
//! field name, a tag, or an optional-field rule shows up as a reviewable diff
//! rather than as a silent incompatibility with the other SDKs.

#![allow(deprecated)]

use ag_ui::*;
use insta::assert_json_snapshot;
use serde_json::json;

#[test]
fn text_message_run() {
    assert_json_snapshot!(vec![
        Event::run_started("thread-1", "run-1").with_timestamp(1_700_000_000_000),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "Hello, "),
        Event::text_message_content("msg-1", "world."),
        Event::text_message_end("msg-1"),
        Event::run_finished_success("thread-1", "run-1"),
    ]);
}

#[test]
fn tool_call_run() {
    assert_json_snapshot!(vec![
        Event::step_started("call_weather_tool"),
        Event::tool_call_start("call-1", "get_weather"),
        Event::tool_call_args("call-1", r#"{"city":"#),
        Event::tool_call_args("call-1", r#""Seoul"}"#),
        Event::tool_call_end("call-1"),
        Event::tool_call_result("msg-2", "call-1", "18C and raining"),
        Event::step_finished("call_weather_tool"),
    ]);
}

#[test]
fn reasoning_run() {
    assert_json_snapshot!(vec![
        Event::reasoning_start("msg-3"),
        Event::reasoning_message_start("msg-3"),
        Event::reasoning_message_content("msg-3", "check the forecast first"),
        Event::reasoning_message_end("msg-3"),
        Event::reasoning_end("msg-3"),
        Event::reasoning_encrypted_value(
            ReasoningEncryptedValueSubtype::Message,
            "msg-3",
            "b64-blob",
        ),
    ]);
}

#[test]
fn deprecated_thinking_run() {
    assert_json_snapshot!(vec![
        Event::thinking_start(Some("Planning".into())),
        Event::thinking_text_message_start(),
        Event::thinking_text_message_content("weighing options"),
        Event::thinking_text_message_end(),
        Event::thinking_end(),
    ]);
}

#[test]
fn state_and_activity_run() {
    let content = json!({ "query": "seoul weather", "results": 0 })
        .as_object()
        .unwrap()
        .clone();

    assert_json_snapshot!(vec![
        Event::state_snapshot(json!({ "counter": 1, "items": [] })),
        Event::state_delta(vec![
            PatchOperation::replace("/counter", json!(2)),
            PatchOperation::add("/items/-", json!("first")),
            PatchOperation::test("/counter", json!(2)),
        ]),
        Event::activity_snapshot("msg-4", "web_search", content),
        Event::activity_delta(
            "msg-4",
            "web_search",
            vec![PatchOperation::replace("/results", json!(3))],
        ),
        Event::messages_snapshot(vec![
            Message::user("msg-0", "What's the weather?"),
            Message::assistant("msg-1", "18C and raining."),
        ]),
    ]);
}

#[test]
fn interrupted_run() {
    let interrupt = Interrupt {
        message: Some("Send the email?".into()),
        tool_call_id: Some(ToolCallId::new("call-1")),
        response_schema: Some(
            json!({ "type": "object", "properties": { "approved": { "type": "boolean" } } })
                .as_object()
                .unwrap()
                .clone(),
        ),
        expires_at: Some("2026-08-17T12:00:00Z".into()),
        ..Interrupt::new("int-1", "tool_approval")
    };

    assert_json_snapshot!(vec![
        Event::run_finished_interrupt("thread-1", "run-1", vec![interrupt]),
        Event::RunFinished(
            RunFinishedEvent::new("thread-1", "run-2")
                .with_result(json!({ "sent": true }))
                .with_usage(vec![TokenUsage {
                    provider: Some("anthropic".into()),
                    model: Some("claude-opus-5".into()),
                    input_tokens: Some(1200),
                    output_tokens: Some(340),
                    reasoning_tokens: Some(64),
                    ..Default::default()
                }]),
        ),
        Event::RunError(RunErrorEvent::new("upstream refused").with_code("BAD_GATEWAY")),
    ]);
}

#[test]
fn escape_hatch_events() {
    assert_json_snapshot!(vec![
        Event::raw(json!({ "provider": "openai", "chunk": { "index": 0 } }))
            .with_timestamp(1_700_000_000_001),
        Event::custom("confetti", json!({ "count": 100 })),
        Event::text_message_chunk(Some("msg-5".into()), Some("partial".into())),
        Event::tool_call_chunk(
            Some("call-2".into()),
            Some("search".into()),
            Some(r#"{"q":"x"}"#.into()),
        ),
        Event::reasoning_message_chunk(Some("msg-6".into()), Some("hmm".into())),
    ]);
}

#[test]
fn run_agent_input() {
    assert_json_snapshot!(RunAgentInput {
        state: json!({ "counter": 1 }),
        messages: vec![
            Message::system("msg-0", "You are helpful."),
            Message::user(
                "msg-1",
                vec![
                    InputContent::text("what is in this image?"),
                    InputContent::Image(MediaInputContent::new(InputContentSource::Data {
                        value: "aGVsbG8=".into(),
                        mime_type: "image/png".into(),
                    })),
                ],
            ),
            Message::Assistant(AssistantMessage {
                id: MessageId::new("msg-2"),
                tool_calls: Some(vec![ToolCall::new(
                    "call-1",
                    "get_weather",
                    r#"{"city":"Seoul"}"#,
                )]),
                ..Default::default()
            }),
            Message::tool("msg-3", "call-1", "18C"),
        ],
        tools: vec![Tool::new(
            "get_weather",
            "Look up the weather for a city",
            json!({
                "type": "object",
                "properties": { "city": { "type": "string" } },
                "required": ["city"],
            }),
        )],
        context: vec![Context::new("current page", "/dashboard")],
        forwarded_props: json!({ "locale": "ko-KR" }),
        resume: Some(vec![ResumeEntry::resolved(
            "int-1",
            json!({ "approved": true }),
        )]),
        ..RunAgentInput::new("thread-1", "run-1")
    });
}

#[test]
fn subagent_run() {
    assert_json_snapshot!(vec![
        Event::SubagentStarted(
            SubagentStartedEvent::new("sub-1", "researcher")
                .with_description("Finds sources for the brief")
                .with_parent_tool_call("call-1")
                .with_parent_message("msg-1"),
        ),
        Event::text_message_start("msg-2", TextMessageRole::Assistant)
            .with_subagent_run_id("sub-1"),
        Event::text_message_content("msg-2", "Three sources found.")
            .with_subagent_run_id("sub-1")
            .with_metadata(
                json!({ "finishReason": "stop" })
                    .as_object()
                    .unwrap()
                    .clone()
            ),
        Event::text_message_end("msg-2").with_subagent_run_id("sub-1"),
        Event::SubagentStarted(
            SubagentStartedEvent::new("sub-2", "reviewer").with_parent_subagent("sub-1"),
        ),
        Event::subagent_finished_suspended("sub-2", vec!["int-1".to_owned()]),
        Event::SubagentFinished(
            SubagentFinishedEvent::new("sub-1")
                .with_result(json!({ "sources": 3 }))
                .with_outcome(SubagentOutcome::Success),
        ),
        Event::SubagentError(SubagentErrorEvent::new("sub-3", "rate limited").with_code("429")),
        Event::run_finished_interrupt(
            "thread-1",
            "run-1",
            vec![Interrupt::new("int-1", "tool_approval").with_subagent_run_id("sub-2")],
        ),
    ]);
}
