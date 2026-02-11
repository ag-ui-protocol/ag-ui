//! Basic agent example using Axum.
//!
//! Run with: `cargo run --example basic_agent`

use ag_ui_core::event::{
    BaseEvent, Event, RunFinishedEvent, RunStartedEvent, TextMessageContentEvent,
    TextMessageEndEvent, TextMessageStartEvent,
};
use ag_ui_core::types::{MessageId, Role, RunId};
use ag_ui_server::integrations::axum::AgentRouter;
use ag_ui_server::prelude::*;
use futures::stream::{self, StreamExt};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// A simple echo agent that responds with a greeting.
struct EchoAgent;

fn base_event() -> BaseEvent {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .ok();
    BaseEvent {
        timestamp,
        raw_event: None,
    }
}

#[async_trait]
impl Agent for EchoAgent {
    type State = serde_json::Value;

    async fn run(
        &self,
        input: RunAgentInput<Self::State>,
        _ctx: AgentContext,
    ) -> AgentResult<BoxStream<'static, AgentResult<Event<Self::State>>>> {
        let thread_id = input.thread_id.clone();
        let run_id = RunId::random();
        let message_id = MessageId::random();

        let events: Vec<AgentResult<Event<Self::State>>> = vec![
            // Start the run
            Ok(Event::RunStarted(RunStartedEvent {
                base: base_event(),
                thread_id: thread_id.clone(),
                run_id: run_id.clone(),
            })),
            // Start a text message
            Ok(Event::TextMessageStart(TextMessageStartEvent {
                base: base_event(),
                message_id: message_id.clone(),
                role: Role::Assistant,
            })),
            // Send message content
            Ok(Event::TextMessageContent(TextMessageContentEvent {
                base: base_event(),
                message_id: message_id.clone(),
                delta: "Hello! I'm an AG-UI echo agent. ".to_string(),
            })),
            Ok(Event::TextMessageContent(TextMessageContentEvent {
                base: base_event(),
                message_id: message_id.clone(),
                delta: "I received your message!".to_string(),
            })),
            // End the text message
            Ok(Event::TextMessageEnd(TextMessageEndEvent {
                base: base_event(),
                message_id,
            })),
            // Finish the run
            Ok(Event::RunFinished(RunFinishedEvent {
                base: base_event(),
                thread_id,
                run_id,
                result: Some(serde_json::json!({"status": "completed"})),
            })),
        ];

        Ok(stream::iter(events).boxed())
    }

    fn name(&self) -> &'static str {
        "echo-agent"
    }
}

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    let agent = Arc::new(EchoAgent);

    // Build the router with default paths
    let app = AgentRouter::new(agent).into_router();

    // Run the server
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000")
        .await
        .expect("failed to bind to address");

    println!("AG-UI agent listening on http://127.0.0.1:3000");
    println!("  POST / - Run the agent");
    println!("  GET /health - Health check");

    axum::serve(listener, app)
        .await
        .expect("server error");
}
