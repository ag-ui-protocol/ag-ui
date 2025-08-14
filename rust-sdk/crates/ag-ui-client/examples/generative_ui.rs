use std::error::Error;
use std::fmt::Debug;

use async_trait::async_trait;
use log::info;
use reqwest::Url;
use serde::{Deserialize, Serialize};

use ag_ui_client::agent::{AgentError, AgentStateMutation, RunAgentParams};
use ag_ui_client::core::AgentState;
use ag_ui_client::core::event::{StateDeltaEvent, StateSnapshotEvent};
use ag_ui_client::core::types::Message;
use ag_ui_client::subscriber::{AgentSubscriber, AgentSubscriberParams};
use ag_ui_client::{Agent, HttpAgent};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Pending,
    Completed,
}

impl Default for StepStatus {
    fn default() -> Self {
        StepStatus::Pending
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Step {
    pub description: String,
    #[serde(default)]
    pub status: StepStatus,
}

impl Step {
    pub fn new(description: String) -> Self {
        Self {
            description,
            status: StepStatus::Pending,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Plan {
    #[serde(default)]
    pub steps: Vec<Step>,
}

impl AgentState for Plan {}

pub struct GenerativeUiSubscriber;

impl GenerativeUiSubscriber {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AgentSubscriber<Plan, ()> for GenerativeUiSubscriber {
    async fn on_state_snapshot_event(
        &self,
        event: &StateSnapshotEvent<Plan>,
        _params: AgentSubscriberParams<'async_trait, Plan, ()>,
    ) -> Result<AgentStateMutation<Plan>, AgentError> {
        info!("State snapshot received:");
        let plan = &event.snapshot;
        info!("   Plan with {} steps:", plan.steps.len());
        for (i, step) in plan.steps.iter().enumerate() {
            let status_icon = match step.status {
                StepStatus::Pending => "[ ]",
                StepStatus::Completed => "[X]",
            };
            info!("   {}. {} {}", i + 1, status_icon, step.description);
        }
        Ok(AgentStateMutation::default())
    }

    async fn on_state_delta_event(
        &self,
        event: &StateDeltaEvent,
        _params: AgentSubscriberParams<'async_trait, Plan, ()>,
    ) -> Result<AgentStateMutation<Plan>, AgentError> {
        info!("State delta received:");
        for patch in &event.delta {
            match patch.get("op").and_then(|v| v.as_str()) {
                Some("replace") => {
                    if let (Some(path), Some(value)) = (
                        patch.get("path").and_then(|v| v.as_str()),
                        patch.get("value"),
                    ) {
                        if path.contains("/status") {
                            let status = value.as_str().unwrap_or("unknown");
                            let status_icon = match status {
                                "completed" => "[X]",
                                "pending" => "[ ]",
                                _ => "[?]",
                            };
                            info!("   {} Step status updated to: {}", status_icon, status);
                        } else if path.contains("/description") {
                            info!(
                                "   Step description updated to: {}",
                                value.as_str().unwrap_or("unknown")
                            );
                        }
                    }
                }
                Some(op) => info!("   Operation: {}", op),
                None => info!("   Unknown operation"),
            }
        }
        Ok(AgentStateMutation::default())
    }

    async fn on_state_changed(
        &self,
        params: AgentSubscriberParams<'async_trait, Plan, ()>,
    ) -> Result<(), AgentError> {
        info!("Overall state changed");
        let completed_steps = params
            .state
            .steps
            .iter()
            .filter(|step| matches!(step.status, StepStatus::Completed))
            .count();
        info!(
            "   Progress: {}/{} steps completed",
            completed_steps,
            params.state.steps.len()
        );

        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    env_logger::Builder::from_default_env().init();

    // Base URL for the mock server
    // Run the following command to start the mock server:
    // `uv run rust-sdk/crates/ag-ui-client/scripts/generative_ui.py`
    let base_url = Url::parse("http://127.0.0.1:3001/")?;

    // Create the HTTP agent
    let agent = HttpAgent::builder().with_url(base_url).build()?;

    let message = Message::new_user(
        "I need to organize a birthday party for my friend. Can you help me \
				create a plan? When you have created the plan, please fully execute it.",
    );

    let subscriber = GenerativeUiSubscriber::new();

    // Create run parameters for testing generative UI with planning
    // State & FwdProps types are defined by GenerativeUiSubscriber
    let params = RunAgentParams::new_typed().add_message(message);

    info!("Starting generative UI agent run...");
    info!("Testing planning functionality with state snapshots and deltas");

    let result = agent.run_agent(&params, [subscriber]).await?;

    info!("Agent run completed successfully!");
    info!("Final result: {}", result.result);
    info!("Generated {} new messages", result.new_messages.len());
    info!("Final state: {:#?}", result.new_state);

    // Print the messages for debugging
    for (i, message) in result.new_messages.iter().enumerate() {
        info!("Message {}: {:?}", i + 1, message);
    }

    Ok(())
}
