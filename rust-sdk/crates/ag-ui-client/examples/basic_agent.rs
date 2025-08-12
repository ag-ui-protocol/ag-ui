use ag_ui_client::Agent;
use ag_ui_client::agent::{AgentError, RunAgentParams};
use ag_ui_client::http::HttpAgent;

use ag_ui_core::JsonValue;
use ag_ui_core::types::ids::MessageId;
use ag_ui_core::types::message::Message;
use log::info;
use reqwest::Url;

#[tokio::main]
async fn main() -> Result<(), AgentError> {
    env_logger::Builder::from_default_env().init();

    // Base URL for the mock server
    // Run the following command to start the mock server:
    // `uv run rust-sdk/crates/ag-ui-client/scripts/basic_agent.py`
    let base_url = Url::parse("http://127.0.0.1:3001/").map_err(|e| AgentError::ConfigError {
        message: e.to_string(),
    })?;

    // Create agent
    let agent = HttpAgent::builder().with_url(base_url).build()?;

    // Create run parameters
    let params = RunAgentParams::<JsonValue, _> {
        forwarded_props: Some(serde_json::json!({})),
        messages: vec![Message::User {
            id: MessageId::random(),
            content: "Can you give me the current temperature in New York?".into(),
            name: None,
        }],
        ..Default::default()
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
