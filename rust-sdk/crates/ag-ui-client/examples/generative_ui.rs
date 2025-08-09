use std::error::Error;
use std::fmt::{Debug, Display, Formatter};

use async_trait::async_trait;
use log::info;
use reqwest::Url;
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};

use ag_ui_client::agent::{AgentError, AgentStateMutation, RunAgentParams};
use ag_ui_client::subscriber::{AgentSubscriber, AgentSubscriberParams};
use ag_ui_client::{Agent, HttpAgent};
use ag_ui_core::event::{StateDeltaEvent, StateSnapshotEvent};
use ag_ui_core::types::ids::MessageId;
use ag_ui_core::types::message::Message;
use ag_ui_core::{AgentState, FwdProps, JsonValue};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Hash)]
pub enum StepStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "completed")]
    Completed,
}

impl Display for StepStatus {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            StepStatus::Pending => write!(f, "pending"),
            StepStatus::Completed => write!(f, "completed"),
        }
    }
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
impl<FwdPropsT> AgentSubscriber<Plan, FwdPropsT> for GenerativeUiSubscriber
where
    FwdPropsT: FwdProps + Debug,
{
    async fn on_state_snapshot_event(
        &self,
        event: &StateSnapshotEvent<Plan>,
        _params: AgentSubscriberParams<'async_trait, Plan, FwdPropsT>,
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
        _params: AgentSubscriberParams<'async_trait, Plan, FwdPropsT>,
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
        params: AgentSubscriberParams<'async_trait, Plan, FwdPropsT>,
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
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let base_url = Url::parse("http://127.0.0.1:3001/")?;
    let headers = HeaderMap::new();

    // Create the HTTP agent
    let agent = HttpAgent::new(base_url, headers);

    let subscriber = GenerativeUiSubscriber::new();

    // Create run parameters for testing generative UI with planning
    let params = RunAgentParams {
        messages: vec![Message::User {
            id: MessageId::random(),
            content: "I need to organize a birthday party for my friend. Can you help me \
				create a plan? When you have created the plan, please fully execute it."
                .into(),
            name: None,
        }],
        forwarded_props: Some(JsonValue::Null),
        ..Default::default()
    };

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
