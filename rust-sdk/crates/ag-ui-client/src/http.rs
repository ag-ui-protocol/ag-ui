use std::string::ParseError;
use crate::Agent;
use crate::agent::AgentError;
use crate::stream::EventStream;
use ag_ui_core::event::Event;
use ag_ui_core::types::input::RunAgentInput;
use ag_ui_core::{AgentState, FwdProps};
use async_trait::async_trait;
use futures::StreamExt;
use reqwest::header::HeaderMap;
use reqwest::{Client as HttpClient, Url};
use sse_client::EventSource;

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
        let event_source = EventSource::new(&self.base_url.as_str())
            .map_err(|e| AgentError::ExecutionError {
                message: e.to_string(),
            })?;

        let stream = self
            .http_client
            .post(self.base_url.clone())
            .json(input)
            .headers(self.header_map.clone())
            .send()
            .await?
            .bytes_stream()
            .map(|result| {
                result.map_err(Into::into).and_then(|bytes| {
                    serde_json::from_slice::<Event<StateT>>(&bytes).map_err(|e| {
                        AgentError::ExecutionError {
                            message: e.to_string(),
                        }
                    })
                })
            })
            .boxed();

        Ok(stream)
    }
}
