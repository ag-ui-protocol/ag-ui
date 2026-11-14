#![allow(dead_code)]
use ag_ui_client::{
    Agent,
    agent::AgentError,
    core::{event::Event, types::RunAgentInput},
};
use futures::stream::{self, BoxStream};
use serde_json::{Value, json};

pub fn input(run: &str) -> RunAgentInput {
    RunAgentInput::new("thread", run, json!({}), vec![], vec![], vec![], json!({}))
}
pub fn start(run: &str) -> Value {
    json!({"type":"RUN_STARTED","threadId":"thread","runId":run})
}
pub fn finish(run: &str) -> Value {
    json!({"type":"RUN_FINISHED","threadId":"thread","runId":run})
}
pub fn event(value: Value) -> Event {
    serde_json::from_value(value).unwrap()
}
pub struct Script(pub Vec<Value>);
#[async_trait::async_trait]
impl Agent for Script {
    async fn run(
        &self,
        _: &RunAgentInput,
    ) -> Result<BoxStream<'async_trait, Result<Event, AgentError>>, AgentError> {
        Ok(Box::pin(stream::iter(
            self.0
                .iter()
                .cloned()
                .map(|v| Ok(event(v)))
                .collect::<Vec<_>>(),
        )))
    }
}
pub async fn run(values: Vec<Value>) -> Result<ag_ui_client::RunAgentResult<Value>, AgentError> {
    Script(values).run_input(&input("requested"), ()).await
}
pub fn message(value: Value) -> ag_ui_client::core::types::Message {
    serde_json::from_value(value).unwrap()
}
pub fn values(messages: &[ag_ui_client::core::types::Message]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| serde_json::to_value(m).unwrap())
        .collect()
}
