#[cfg(test)]
mod tests {
    use ag_ui_core::error::AguiError;
    use ag_ui_core::types::context::Context;
    use ag_ui_core::types::ids::{MessageId, RunId, ThreadId, ToolCallId};
    use ag_ui_core::types::input::*;
    use ag_ui_core::types::message::{
        AssistantMessage, DeveloperMessage, FunctionCall, Message, Role, SystemMessage,
        ToolMessage, UserMessage,
    };
    use ag_ui_core::types::tool::{Tool, ToolCall};
    use serde::{Deserialize, Serialize};
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn test_role_serialization() {
        let role = Role::Developer;
        let json = serde_json::to_string(&role).unwrap();
        assert_eq!(json, r#"{"role":"developer"}"#);
    }

    #[test]
    fn test_message_types() {
        let dev_msg = DeveloperMessage::new(MessageId::random(), "dev content".to_string())
            .with_name("dev".to_string());
        assert_eq!(dev_msg.role, Role::Developer);
        assert_eq!(dev_msg.name, Some("dev".to_string()));

        let sys_msg = SystemMessage::new(MessageId::random(), "sys content".to_string())
            .with_name("sys".to_string());
        assert_eq!(sys_msg.role, Role::System);

        let user_msg = UserMessage::new(MessageId::random(), "user content".to_string())
            .with_name("user".to_string());
        assert_eq!(user_msg.role, Role::User);

        let tool_msg = ToolMessage::new(
            MessageId::random(),
            "result".to_string(),
            ToolCallId::random(),
        )
        .with_error("error".to_string());
        assert_eq!(tool_msg.role, Role::Tool);
        assert_eq!(tool_msg.error, Some("error".to_string()));
    }

    #[test]
    fn test_message_serialization() {
        let user_msg = Message::User {
            id: MessageId::random(),
            content: "Hello".to_string(),
            name: None,
        };

        let json = serde_json::to_string(&user_msg).unwrap();
        let deserialized: Message = serde_json::from_str(&json).unwrap();

        assert_eq!(user_msg, deserialized);
    }

    #[test]
    fn test_tool_call_creation() {
        let function_call = FunctionCall {
            name: "test_function".to_string(),
            arguments: "{}".to_string(),
        };

        let tool_call = ToolCall::new(ToolCallId::random(), function_call);
        assert_eq!(tool_call.call_type, "function");
    }

    #[test]
    fn test_assistant_message_builder() {
        let msg = AssistantMessage::new(MessageId::random())
            .with_content("Hello".to_string())
            .with_name("Assistant".to_string());

        assert_eq!(msg.content, Some("Hello".to_string()));
        assert_eq!(msg.name, Some("Assistant".to_string()));
    }

    #[test]
    fn test_context_and_tool() {
        let context = Context::new("test desc".to_string(), "test value".to_string());
        assert_eq!(context.description, "test desc");

        let tool = Tool::new(
            "test_tool".to_string(),
            "tool desc".to_string(),
            json!({"type": "object"}),
        );
        assert_eq!(tool.name, "test_tool");
    }

    #[test]
    fn test_agui_error() {
        let error = AguiError::new("test error");
        assert_eq!(error.to_string(), "AG-UI Error: test error");
    }

    #[test]
    fn test_custom_state() {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        struct CustomState {
            pub document: String,
            pub num_edits: u64,
        }

        let state = CustomState {
            document: "Hello, world!".to_string(),
            num_edits: 0,
        };

        // If this compiles, it's okay
        let _input = RunAgentInput::new(
            ThreadId::random(),
            RunId::random(),
            state,
            vec![],
            vec![],
            vec![],
            json!({}),
        );
    }

    #[test]
    fn test_custom_forward_props() {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        struct CustomFwdProps {
            pub document: String,
            pub num_edits: u64,
        }

        let fwd_props = CustomFwdProps {
            document: "Hello, world!".to_string(),
            num_edits: 0,
        };

        // If this compiles, it's okay
        let _input = RunAgentInput::new(
            Uuid::new_v4(),
            Uuid::new_v4(),
            json!({}),
            vec![],
            vec![],
            vec![],
            fwd_props,
        );
    }

    #[test]
    fn test_complex_assistant_message_deserialization() {
        let json_str = r#"{
			"role": "assistant",
			"id": "00000000-0000-0000-0000-000000000000",
			"content": "I'll help you with that function.",
			"name": "CodeHelper",
			"toolCalls": [
				{
					"id": "00000000-0000-0000-0000-000000000000",
					"type": "function",
					"function": {
						"name": "write_function",
						"arguments": "{\"language\":\"rust\",\"name\":\"example\"}"
					}
				}
			]
		}"#;

        let msg: Message = serde_json::from_str(json_str).unwrap();
        match msg {
            Message::Assistant {
                id,
                content,
                name,
                tool_calls,
            } => {
                assert_eq!(id.to_string(), "00000000-0000-0000-0000-000000000000");
                assert_eq!(
                    content,
                    Some("I'll help you with that function.".to_string())
                );
                assert_eq!(name, Some("CodeHelper".to_string()));
                assert!(tool_calls.is_some());
                let calls = tool_calls.unwrap();
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].function.name, "write_function");
            }
            _ => panic!("Wrong message type"),
        }
    }

    #[test]
    fn test_complex_message_array_deserialization() {
        let json_str = r#"[
			{
				"role": "user",
				"id": "00000000-0000-0000-0000-000000000000",
				"content": "Hello!",
				"name": "Alice"
			},
			{
				"role": "assistant",
				"id": "00000000-0000-0000-0000-000000000000",
				"content": "Hi Alice!",
				"name": "Assistant"
			},
			{
				"role": "tool",
				"id": "00000000-0000-0000-0000-000000000000",
				"content": "Function result",
				"toolCallId": "00000000-0000-0000-0000-000000000000"
			}
		]"#;

        let messages: Vec<Message> = serde_json::from_str(json_str).unwrap();
        assert_eq!(messages.len(), 3);

        match &messages[0] {
            Message::User { id, content, name } => {
                assert_eq!(id.to_string(), "00000000-0000-0000-0000-000000000000");
                assert_eq!(content, "Hello!");
                assert_eq!(*name, Some("Alice".to_string()));
            }
            _ => panic!("Wrong message type"),
        }
    }

    #[test]
    fn test_complex_run_agent_input_deserialization() {
        let json_str = r#"{
			"threadId": "00000000-0000-0000-0000-000000000000",
			"runId": "00000000-0000-0000-0000-000000000000",
			"state": {"counter": 42},
			"messages": [
				{
					"role": "user",
					"id": "00000000-0000-0000-0000-000000000000",
					"content": "Hello"
				}
			],
			"tools": [
				{
					"name": "calculator",
					"description": "Performs calculations",
					"parameters": {
						"type": "object",
						"properties": {
							"operation": {"type": "string"}
						}
					}
				}
			],
			"context": [
				{
					"description": "Current time",
					"value": "2024-02-14T12:00:00Z"
				}
			],
			"forwardedProps": {"settings": {"debug": true}}
		}"#;

        let input: RunAgentInput = serde_json::from_str(json_str).unwrap();
        assert_eq!(input.messages.len(), 1);
        assert_eq!(input.tools.len(), 1);
        assert_eq!(input.context.len(), 1);
    }

    #[test]
    fn test_complex_run_agent_input_deserialization_custom_state() {
        #[derive(Debug, Deserialize, Serialize)]
        struct CustomState {
            counter: u32,
        }

        #[derive(Debug, Deserialize, Serialize)]
        struct OtherState {
            document: String,
        }

        let json_str = r#"{
			"threadId": "00000000-0000-0000-0000-000000000000",
			"runId": "00000000-0000-0000-0000-000000000000",
			"state": {"counter": 42},
			"messages": [
				{
					"role": "user",
					"id": "00000000-0000-0000-0000-000000000000",
					"content": "Hello"
				}
			],
			"tools": [
				{
					"name": "calculator",
					"description": "Performs calculations",
					"parameters": {
						"type": "object",
						"properties": {
							"operation": {"type": "string"}
						}
					}
				}
			],
			"context": [
				{
					"description": "Current time",
					"value": "2024-02-14T12:00:00Z"
				}
			],
			"forwardedProps": {"settings": {"debug": true}}
		}"#;

        let input: RunAgentInput<CustomState> = serde_json::from_str(json_str).unwrap();
        assert_eq!(input.messages.len(), 1);
        assert_eq!(input.tools.len(), 1);
        assert_eq!(input.context.len(), 1);

        let wrong_input: serde_json::Result<RunAgentInput<OtherState>> =
            serde_json::from_str(json_str);
        assert!(wrong_input.is_err())
    }
}
