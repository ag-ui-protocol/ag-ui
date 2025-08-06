use crate::Agent;
use crate::agent::AgentError;
use crate::sse::SseResponseExt;
use crate::stream::EventStream;
use ag_ui_core::event::Event;
use ag_ui_core::types::input::RunAgentInput;
use ag_ui_core::{AgentState, FwdProps};
use async_trait::async_trait;
use futures::StreamExt;
use log::trace;
use reqwest::header::HeaderMap;
use reqwest::{Client as HttpClient, Url};

pub struct HttpAgent {
    http_client: HttpClient,
    base_url: Url,
    header_map: HeaderMap,
}

impl HttpAgent {
    pub fn new(base_url: Url, header_map: impl Into<HeaderMap>) -> Self {
        let http_client = HttpClient::new();
        Self {
            http_client,
            base_url,
            header_map: header_map.into(),
        }
    }
}

impl From<reqwest::Error> for AgentError {
    fn from(err: reqwest::Error) -> Self {
        AgentError::ExecutionError {
            message: err.to_string(),
        }
    }
}

#[async_trait]
impl<StateT: AgentState, FwdPropsT: FwdProps> Agent<StateT, FwdPropsT> for HttpAgent {
    async fn run(
        &self,
        input: &RunAgentInput<StateT, FwdPropsT>,
    ) -> Result<EventStream<'async_trait, StateT>, AgentError> {
        // Send the request and get the response
        let response = self
            .http_client
            .post(self.base_url.clone())
            .json(input)
            .headers(self.header_map.clone())
            .send()
            .await?;

        // Convert the response to an SSE event stream
        let stream = response
            .event_source()
            .await
            .map(|result| match result {
                Ok(event) => {
                    // trace!("Received event: {event:?}");
                    let event_data: Event<StateT> = serde_json::from_str(&event.data)?;
                    trace!("Deserialized event: {event_data:?}");
                    Ok(event_data)
                }
                Err(err) => Err(AgentError::ExecutionError {
                    message: err.to_string(),
                }),
            })
            .boxed();
        Ok(stream)
    }
}
