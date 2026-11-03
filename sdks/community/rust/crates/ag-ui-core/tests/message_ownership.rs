use ag_ui_core::types::{Message, Role};

#[test]
fn ownership_accessor_covers_every_current_message_variant() {
    for role in [
        Role::Developer,
        Role::System,
        Role::Assistant,
        Role::User,
        Role::Tool,
        Role::Activity,
        Role::Reasoning,
    ] {
        let message = Message::new(role, "message", "content");
        assert_eq!(message.subagent_run_id(), None);
        let mut wire = serde_json::to_value(message).unwrap();
        wire["subagentRunId"] = "child-run".into();
        let message: Message = serde_json::from_value(wire).unwrap();
        assert_eq!(
            message.subagent_run_id().map(String::as_str),
            Some("child-run")
        );
    }
}
