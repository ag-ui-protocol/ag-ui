use ag_ui_client::{Agent, HttpAgent, RunAgentParams, core::types::Message};
use std::error::Error;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let agent = HttpAgent::builder()
        .with_url_str("http://127.0.0.1:3001/")?
        .build()?;

    let message = Message::new_user("Can you give me the current temperature in New York?");
    // Create run parameters
    let params = RunAgentParams::new().add_message(message);

    // Run the agent with the subscriber
    let result = agent.run_agent(&params, ()).await?;

    println!("{:#?}", result);
    Ok(())
}
