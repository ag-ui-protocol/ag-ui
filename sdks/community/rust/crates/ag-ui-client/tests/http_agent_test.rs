//! Integration tests for HttpAgent.
//!
//! These tests use a mock AG-UI server that runs on a random available port.
//! The mock server returns canned SSE events for testing the client.

use ag_ui_client::HttpAgent;
use ag_ui_client::agent::{Agent, RunAgentParams};
use ag_ui_client::core::types::{Message, Role};
use std::net::SocketAddr;
use tokio::sync::oneshot;

mod mock_server {
    //! A minimal mock AG-UI server for integration testing.
    //!
    //! This server returns canned SSE events to test the client without
    //! requiring external dependencies like Python or OpenAI.

    use axum::body::Body;
    use axum::http::header::{CACHE_CONTROL, CONNECTION, CONTENT_TYPE};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::routing::post;
    use axum::Router;
    use std::net::SocketAddr;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    // Fixed UUIDs for deterministic testing
    const THREAD_ID: &str = "550e8400-e29b-41d4-a716-446655440000";
    const RUN_ID: &str = "550e8400-e29b-41d4-a716-446655440001";
    const MSG_ID: &str = "550e8400-e29b-41d4-a716-446655440002";

    /// Canned SSE events for a basic text message response.
    fn text_message_events() -> String {
        // Events follow AG-UI protocol:
        // RUN_STARTED -> TEXT_MESSAGE_START -> TEXT_MESSAGE_CONTENT -> TEXT_MESSAGE_END -> RUN_FINISHED
        let events = [
            format!(r#"{{"type":"RUN_STARTED","threadId":"{}","runId":"{}"}}"#, THREAD_ID, RUN_ID),
            format!(r#"{{"type":"TEXT_MESSAGE_START","messageId":"{}","role":"assistant"}}"#, MSG_ID),
            format!(r#"{{"type":"TEXT_MESSAGE_CONTENT","messageId":"{}","delta":"Hello! "}}"#, MSG_ID),
            format!(r#"{{"type":"TEXT_MESSAGE_CONTENT","messageId":"{}","delta":"I am the mock server."}}"#, MSG_ID),
            format!(r#"{{"type":"TEXT_MESSAGE_END","messageId":"{}"}}"#, MSG_ID),
            format!(r#"{{"type":"RUN_FINISHED","threadId":"{}","runId":"{}"}}"#, THREAD_ID, RUN_ID),
        ];

        events
            .iter()
            .map(|e| format!("data: {}\n\n", e))
            .collect()
    }

    /// Canned SSE events that include a tool call.
    fn tool_call_events() -> String {
        // Events follow AG-UI protocol with tool calls:
        // RUN_STARTED -> TOOL_CALL_START -> TOOL_CALL_ARGS -> TOOL_CALL_END -> RUN_FINISHED
        let events = [
            format!(r#"{{"type":"RUN_STARTED","threadId":"{}","runId":"{}"}}"#, THREAD_ID, RUN_ID),
            format!(r#"{{"type":"TEXT_MESSAGE_START","messageId":"{}","role":"assistant"}}"#, MSG_ID),
            format!(r#"{{"type":"TOOL_CALL_START","toolCallId":"call_12345678","toolCallName":"get_temperature","parentMessageId":"{}"}}"#, MSG_ID),
            r#"{"type":"TOOL_CALL_ARGS","toolCallId":"call_12345678","delta":"{\"location\":"}"#.to_string(),
            r#"{"type":"TOOL_CALL_ARGS","toolCallId":"call_12345678","delta":"\"Amsterdam\",\"unit\":\"celsius\"}"}"#.to_string(),
            r#"{"type":"TOOL_CALL_END","toolCallId":"call_12345678"}"#.to_string(),
            format!(r#"{{"type":"TEXT_MESSAGE_END","messageId":"{}"}}"#, MSG_ID),
            format!(r#"{{"type":"RUN_FINISHED","threadId":"{}","runId":"{}"}}"#, THREAD_ID, RUN_ID),
        ];

        events
            .iter()
            .map(|e| format!("data: {}\n\n", e))
            .collect()
    }

    /// Handler that returns SSE events based on message content.
    async fn run_agent_handler(body: String) -> Response {
        // Check if the request mentions "tool" or "temperature" to trigger tool call response
        let events = if body.to_lowercase().contains("celsius")
            || body.to_lowercase().contains("temperature")
        {
            tool_call_events()
        } else {
            text_message_events()
        };

        Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "text/event-stream")
            .header(CACHE_CONTROL, "no-cache")
            .header(CONNECTION, "keep-alive")
            .body(Body::from(events))
            .expect("response builder should not fail")
    }

    /// Health check handler for completeness.
    async fn health_handler() -> impl IntoResponse {
        (
            StatusCode::OK,
            r#"{"status":"healthy","agent":"mock-agent"}"#,
        )
    }

    /// Start the mock server on an available port.
    ///
    /// Returns the socket address and a shutdown sender.
    /// Send to the sender to gracefully shut down the server.
    pub async fn start() -> (SocketAddr, oneshot::Sender<()>) {
        let app = Router::new()
            .route("/", post(run_agent_handler))
            .route("/health", axum::routing::get(health_handler));

        // Bind to port 0 to get an available port
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind to address");

        let addr = listener.local_addr().expect("failed to get local address");

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        // Spawn the server in a background task
        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("server error");
        });

        // Give the server a moment to start
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        (addr, shutdown_tx)
    }
}

/// Helper to start mock server and create an agent pointing to it.
async fn setup_test() -> (HttpAgent, SocketAddr, oneshot::Sender<()>) {
    let (addr, shutdown_tx) = mock_server::start().await;

    let agent = HttpAgent::builder()
        .with_url_str(&format!("http://{}/", addr))
        .unwrap()
        .build()
        .unwrap();

    (agent, addr, shutdown_tx)
}

#[tokio::test]
async fn test_http_agent_basic_functionality() {
    let _ = env_logger::try_init();

    let (agent, _addr, _shutdown) = setup_test().await;

    // Create a message asking something simple
    let message = Message::new_user("Hello, how are you?");

    // Set up the run parameters
    let params = RunAgentParams::new().add_message(message);

    // Run the agent
    let result = agent.run_agent(&params, ()).await;

    // Check that the run was successful
    assert!(result.is_ok(), "Agent run failed: {:?}", result.err());

    // Check that we got some messages back
    let result = result.unwrap();
    assert!(!result.new_messages.is_empty(), "No messages returned");

    // Print the messages for debugging
    for msg in &result.new_messages {
        println!("Message role: {:?}", msg.role());
        println!("Message content: {:?}", msg.content().unwrap());
    }

    // Check that we got a response from the assistant
    assert!(
        result
            .new_messages
            .iter()
            .any(|m| m.role() == Role::Assistant),
        "No assistant messages returned"
    );

    // Verify the message content
    let assistant_msg = result
        .new_messages
        .iter()
        .find(|m| m.role() == Role::Assistant)
        .unwrap();
    let content = assistant_msg.content().unwrap();
    assert!(
        content.contains("mock server"),
        "Expected mock response content"
    );
}

#[tokio::test]
async fn test_http_agent_tool_calls() {
    let _ = env_logger::try_init();

    let (agent, _addr, _shutdown) = setup_test().await;

    // Create a message that should trigger a tool call
    let message = Message::new_user("What's the temperature in Amsterdam in Celsius?");

    // Set up the run parameters
    let params = RunAgentParams::new().add_message(message);

    // Run the agent
    let result = agent.run_agent(&params, ()).await;

    // Check that the run was successful
    assert!(result.is_ok(), "Agent run failed: {:?}", result.err());

    // Check that we got some messages back
    let result = result.unwrap();
    assert!(!result.new_messages.is_empty(), "No messages returned");

    // Check that at least one message has tool calls
    let has_tool_calls = result.new_messages.iter().any(|m| {
        if let Some(tool_calls) = m.tool_calls() {
            !tool_calls.is_empty()
        } else {
            false
        }
    });

    assert!(has_tool_calls, "No tool calls were made");

    // Verify the tool call details
    for msg in &result.new_messages {
        if let Some(tool_calls) = msg.tool_calls() {
            for tool_call in tool_calls {
                println!(
                    "Tool call: {} with args {}",
                    tool_call.function.name, tool_call.function.arguments
                );
                assert_eq!(tool_call.function.name, "get_temperature");
                assert!(tool_call.function.arguments.contains("Amsterdam"));
            }
        }
    }
}

#[tokio::test]
async fn test_http_agent_error_handling() {
    let _ = env_logger::try_init();

    // Create an HttpAgent with an invalid URL (nothing listening)
    let agent = HttpAgent::builder()
        .with_url_str("http://127.0.0.1:59999/invalid")
        .unwrap()
        .build()
        .unwrap();

    // Create a simple message
    let message = Message::new_user("Hello.");

    // Set up the run parameters
    let params = RunAgentParams::new().add_message(message);

    // Run the agent
    let result = agent.run_agent(&params, ()).await;

    // Check that the run failed as expected
    assert!(
        result.is_err(),
        "Agent run should have failed but succeeded"
    );
}

#[tokio::test]
async fn test_mock_server_port_isolation() {
    // Start two mock servers and verify they get different ports
    let (addr1, shutdown1) = mock_server::start().await;
    let (addr2, shutdown2) = mock_server::start().await;

    assert_ne!(
        addr1.port(),
        addr2.port(),
        "Servers should be on different ports"
    );

    // Clean up
    let _ = shutdown1.send(());
    let _ = shutdown2.send(());
}
