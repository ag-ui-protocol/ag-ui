//! The message union, its multimodal parts, and the run input that carries them.

use ag_ui::*;
use serde_json::json;

fn every_message() -> Vec<(Message, &'static str)> {
    vec![
        (
            Message::Developer(DeveloperMessage {
                id: MessageId::new("msg-0"),
                content: "Answer in Korean.".into(),
                name: Some("ops".into()),
                encrypted_value: None,
                ..Default::default()
            }),
            "developer",
        ),
        (Message::system("msg-1", "You are helpful."), "system"),
        (
            Message::Assistant(AssistantMessage {
                id: MessageId::new("msg-2"),
                content: None,
                tool_calls: Some(vec![ToolCall::new(
                    "call-1",
                    "get_weather",
                    r#"{"city":"Seoul"}"#,
                )]),
                ..Default::default()
            }),
            "assistant",
        ),
        (Message::user("msg-3", "What's the weather?"), "user"),
        (Message::tool("msg-4", "call-1", "18C"), "tool"),
        (
            Message::Activity(ActivityMessage {
                id: MessageId::new("msg-5"),
                activity_type: "web_search".into(),
                content: json!({ "query": "seoul weather" })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            }),
            "activity",
        ),
        (
            Message::Reasoning(ReasoningMessage {
                id: MessageId::new("msg-6"),
                content: "check the forecast first".into(),
                encrypted_value: Some("b64-blob".into()),
                ..Default::default()
            }),
            "reasoning",
        ),
    ]
}

#[test]
fn every_role_round_trips_and_is_tagged_by_role() {
    for (message, role) in every_message() {
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["role"], role);
        assert_eq!(message.role().as_str(), role);

        let back: Message = serde_json::from_value(json).unwrap();
        assert_eq!(back, message);
        assert_eq!(back.id(), message.id());
    }
}

#[test]
fn the_message_union_covers_every_role() {
    assert_eq!(every_message().len(), 7);
}

#[test]
fn an_assistant_tool_call_keeps_the_function_type_literal() {
    let call = ToolCall::new("call-1", "get_weather", r#"{"city":"Seoul"}"#);
    assert_eq!(
        serde_json::to_value(&call).unwrap(),
        json!({
            "id": "call-1",
            "type": "function",
            "function": { "name": "get_weather", "arguments": r#"{"city":"Seoul"}"# }
        })
    );
    assert_eq!(
        serde_json::from_value::<ToolCall>(serde_json::to_value(&call).unwrap()).unwrap(),
        call
    );
    assert_eq!(call.kind, ToolCallKind::Function);
}

#[test]
fn user_content_is_either_a_string_or_a_list_of_parts() {
    let plain = Message::user("msg-1", "hello");
    assert_eq!(
        serde_json::to_value(&plain).unwrap(),
        json!({ "role": "user", "id": "msg-1", "content": "hello" })
    );

    let multimodal = Message::user(
        "msg-2",
        vec![
            InputContent::text("what is in this image?"),
            InputContent::Image(MediaInputContent::new(InputContentSource::Data {
                value: "aGVsbG8=".into(),
                mime_type: "image/png".into(),
            })),
            InputContent::Document(MediaInputContent {
                source: InputContentSource::Url {
                    value: "https://example.com/report.pdf".into(),
                    mime_type: None,
                },
                metadata: Some(json!({ "pages": 12 })),
            }),
        ],
    );

    let json = serde_json::to_value(&multimodal).unwrap();
    assert_eq!(
        json["content"][0],
        json!({ "type": "text", "text": "what is in this image?" })
    );
    assert_eq!(json["content"][1]["type"], "image");
    assert_eq!(json["content"][1]["source"]["mimeType"], "image/png");
    assert_eq!(json["content"][2]["type"], "document");
    // An absent optional stays absent, even nested three levels down.
    assert!(json["content"][2]["source"].get("mimeType").is_none());

    assert_eq!(serde_json::from_value::<Message>(json).unwrap(), multimodal);
}

#[test]
fn the_legacy_binary_part_still_parses() {
    let part: InputContent = serde_json::from_str(
        r#"{"type":"binary","mimeType":"application/zip","url":"https://example.com/a.zip"}"#,
    )
    .unwrap();

    let InputContent::Binary(binary) = &part else {
        panic!("wrong variant");
    };
    assert!(binary.has_payload());
    assert!(!BinaryInputContent::default().has_payload());
    assert_eq!(
        serde_json::from_value::<InputContent>(serde_json::to_value(&part).unwrap()).unwrap(),
        part
    );
}

#[test]
fn a_full_run_input_round_trips() {
    let input = RunAgentInput {
        parent_run_id: Some(RunId::new("run-0")),
        state: json!({ "counter": 1 }),
        messages: every_message()
            .into_iter()
            .map(|(message, _)| message)
            .collect(),
        tools: vec![Tool {
            metadata: Some(json!({ "a2ui": true }).as_object().unwrap().clone()),
            ..Tool::new("get_weather", "Look it up", json!({ "type": "object" }))
        }],
        context: vec![Context::new("page", "/dashboard")],
        forwarded_props: json!({ "locale": "ko-KR" }),
        resume: Some(vec![
            ResumeEntry::resolved("int-1", json!({ "approved": true })),
            ResumeEntry::cancelled("int-2"),
        ]),
        ..RunAgentInput::new("thread-1", "run-1")
    };

    let text = serde_json::to_string(&input).unwrap();
    let back: RunAgentInput = serde_json::from_str(&text).unwrap();
    assert_eq!(back, input);
    assert_eq!(serde_json::to_string(&back).unwrap(), text);

    let json = serde_json::to_value(&input).unwrap();
    assert_eq!(json["resume"][0]["status"], "resolved");
    assert_eq!(json["resume"][1]["status"], "cancelled");
    assert!(json["resume"][1].get("payload").is_none());
    assert_eq!(ResumeStatus::Cancelled.as_str(), "cancelled");
}

#[test]
fn messages_survive_a_messages_snapshot() {
    let messages: Vec<Message> = every_message()
        .into_iter()
        .map(|(message, _)| message)
        .collect();

    let event = Event::messages_snapshot(messages.clone());
    let back: Event = serde_json::from_value(serde_json::to_value(&event).unwrap()).unwrap();
    assert_eq!(back, event);

    let Event::MessagesSnapshot(payload) = back else {
        panic!("wrong variant");
    };
    assert_eq!(payload.messages, messages);
}

#[test]
fn capabilities_round_trip_and_omit_what_is_not_declared() {
    let capabilities = AgentCapabilities {
        identity: Some(IdentityCapabilities {
            name: Some("weather-bot".into()),
            kind: Some("langgraph".into()),
            documentation_url: Some("https://example.com".into()),
            ..Default::default()
        }),
        transport: Some(TransportCapabilities {
            streaming: Some(true),
            ..Default::default()
        }),
        human_in_the_loop: Some(HumanInTheLoopCapabilities {
            interrupts: Some(true),
            approve_with_edits: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    };

    let json = serde_json::to_value(&capabilities).unwrap();
    assert_eq!(json["identity"]["type"], "langgraph");
    assert_eq!(json["identity"]["documentationUrl"], "https://example.com");
    assert_eq!(json["humanInTheLoop"]["approveWithEdits"], true);
    assert!(json.get("multimodal").is_none());
    assert!(json["transport"].get("websocket").is_none());

    assert_eq!(
        serde_json::from_value::<AgentCapabilities>(json).unwrap(),
        capabilities
    );
}

#[test]
fn token_usage_aggregates_per_provider_and_model() {
    let calls = vec![
        TokenUsage {
            provider: Some("anthropic".into()),
            model: Some("claude-opus-5".into()),
            input_tokens: Some(100),
            output_tokens: Some(20),
            ..Default::default()
        },
        TokenUsage {
            provider: Some("anthropic".into()),
            model: Some("claude-opus-5".into()),
            input_tokens: Some(50),
            reasoning_tokens: Some(5),
            ..Default::default()
        },
        TokenUsage {
            provider: Some("openai".into()),
            model: Some("gpt-x".into()),
            total_tokens: Some(9),
            ..Default::default()
        },
    ];

    let totals = aggregate_token_usage(&calls);
    assert_eq!(totals.len(), 2);
    assert_eq!(totals[0].model.as_deref(), Some("claude-opus-5"));
    assert_eq!(totals[0].input_tokens, Some(150));
    assert_eq!(totals[0].output_tokens, Some(20));
    assert_eq!(totals[0].reasoning_tokens, Some(5));
    // Nobody reported a total, so it stays unreported rather than becoming 0.
    assert_eq!(totals[0].total_tokens, None);
    assert_eq!(totals[1].total_tokens, Some(9));
    assert!(totals[1].has_counts());
    assert!(!TokenUsage::new().has_counts());
}
