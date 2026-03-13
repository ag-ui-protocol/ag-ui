//! Integration tests against a real LangGraph AG-UI server.
//!
//! These tests require:
//! 1. A running LangGraph server at localhost:3001
//! 2. OPENAI_API_KEY environment variable set
//!
//! To run:
//! ```bash
//! # Start the server first:
//! cd integrations/langgraph/python/examples
//! source .venv/bin/activate
//! OPENAI_API_KEY=sk-... python -m uvicorn agents.dojo:app --port 3001
//!
//! # Then run tests:
//! cargo test --test langgraph_server_test -- --ignored
//! ```

use ag_ui_client::HttpAgent;
use ag_ui_client::agent::{Agent, RunAgentParams};
use ag_ui_client::core::types::Message;

#[tokio::test]
#[ignore = "requires LangGraph server at localhost:3001 with OPENAI_API_KEY"]
async fn test_langgraph_agentic_chat() {
    let _ = env_logger::try_init();

    // Create agent pointing to agentic_chat endpoint
    let agent = HttpAgent::builder()
        .with_url_str("http://localhost:3001/agent/agentic_chat")
        .unwrap()
        .build()
        .unwrap();

    let message = Message::new_user("What is 2 + 2?");
    let params = RunAgentParams::new().add_message(message);

    let result = agent.run_agent(&params, ()).await;
    
    match &result {
        Ok(r) => {
            println!("Success! Got {} messages", r.new_messages.len());
            for msg in &r.new_messages {
                println!("  {:?}: {:?}", msg.role(), msg.content());
            }
        }
        Err(e) => {
            println!("Error: {:?}", e);
        }
    }

    assert!(result.is_ok(), "Agent run failed: {:?}", result.err());
    
    let result = result.unwrap();
    assert!(!result.new_messages.is_empty(), "Expected at least one message");
}

#[tokio::test]
#[ignore = "requires LangGraph server at localhost:3001 with OPENAI_API_KEY"]
async fn test_langgraph_shared_state() {
    let _ = env_logger::try_init();

    let agent = HttpAgent::builder()
        .with_url_str("http://localhost:3001/agent/shared_state")
        .unwrap()
        .build()
        .unwrap();

    let message = Message::new_user("Hello, can you help me?");
    let params = RunAgentParams::new().add_message(message);

    let result = agent.run_agent(&params, ()).await;
    
    println!("Result: {:?}", result);
    assert!(result.is_ok(), "Agent run failed: {:?}", result.err());
}
