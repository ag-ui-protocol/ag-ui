use ag_ui_client::{Agent, HttpAgent, RunAgentParams, core::types::Message};
use std::error::Error;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let endpoint =
        std::env::var("AG_UI_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:3001".to_string());
    let agent = HttpAgent::builder()
        .with_url_str(&format!("{}/agentic_chat", endpoint.trim_end_matches('/')))?
        .build()?;

    let message = Message::new_user("Count down from ten.");
    // Create run parameters
    let params = RunAgentParams::new().add_message(message);

    // Run the agent without subscriber
    let result = agent.run_agent(&params, ()).await?;

    for message in &result.new_messages {
        if let Message::Assistant { id, content, .. } = message {
            println!("assistant [{id}]: {}", content.as_deref().unwrap_or(""));
        }
    }
    Ok(())
}
