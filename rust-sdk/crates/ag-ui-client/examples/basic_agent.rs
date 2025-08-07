use ag_ui_client::agent::{AgentError, RunAgentParams};
use ag_ui_client::http::HttpAgent;
use reqwest::Url;
use reqwest::header::{HeaderMap, HeaderValue};

use ag_ui_client::Agent;
use ag_ui_core::types::ids::MessageId;
use ag_ui_core::types::message::Message;
use log::info;

#[tokio::main]
async fn main() -> Result<(), AgentError> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // Create a base URL for the mock server
    // Note: Make sure the mock server is running on this address
    let base_url = Url::parse("http://127.0.0.1:3001/")
        .map_err(|e| AgentError::ConfigError {message: e.to_string() })?;

    // Create headers
    let mut headers = HeaderMap::new();
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));

    // Create the HTTP agent
    let agent = HttpAgent::new(base_url, headers);

    // Create run parameters
    let params = RunAgentParams {
        run_id: None,
        tools: None,
        context: None,
        forwarded_props: Some(serde_json::json!({})),
        messages: vec![Message::User {
            id: MessageId::random(),
            content: "Can you give me the current temperature in New York?".into(),
            name: None,
        }],
        state: serde_json::json!({}),
    };

    info!("Running agent...");

    // Run the agent with the subscriber
    let result = agent.run_agent(&params, ()).await?;

    info!(
        "Agent run completed with {} new messages",
        result.new_messages.len()
    );
    info!("Result: {:#?}", result);

    Ok(())
}
