use crate::Agent;
use crate::agent::AgentError;
use crate::core::event::Event;
use crate::core::types::RunAgentInput;
use crate::core::{AgentState, FwdProps};
use crate::sse::SseResponseExt;
use crate::stream::EventStream;
use ag_ui_core::types::AgentId;
use async_trait::async_trait;
use futures::StreamExt;
use log::{debug, trace};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client as HttpClient, Url};
use std::str::FromStr;

/// Represents an agent that communicates primarily via HTTP.
pub struct HttpAgent {
    http_client: HttpClient,
    base_url: Url,
    header_map: HeaderMap,
    agent_id: Option<AgentId>,
}

impl HttpAgent {
    pub fn new(base_url: Url, header_map: HeaderMap) -> Self {
        let http_client = HttpClient::new();
        let mut header_map: HeaderMap = header_map;

        header_map.insert("Content-Type", HeaderValue::from_static("application/json"));
        Self {
            http_client,
            base_url,
            header_map,
            agent_id: None,
        }
    }

    pub fn builder() -> HttpAgentBuilder {
        HttpAgentBuilder::new()
    }
}

pub struct HttpAgentBuilder {
    base_url: Option<Url>,
    header_map: HeaderMap,
    http_client: Option<HttpClient>,
    agent_id: Option<AgentId>,
}

impl HttpAgentBuilder {
    pub fn new() -> Self {
        Self {
            base_url: None,
            header_map: HeaderMap::new(),
            http_client: None,
            agent_id: None,
        }
    }

    /// Set the base URL from a Url instance
    pub fn with_url(mut self, base_url: Url) -> Self {
        self.base_url = Some(base_url);
        self
    }

    /// Set the base URL from a string, returning Result for validation
    pub fn with_url_str(mut self, url: &str) -> Result<Self, AgentError> {
        let parsed_url = Url::parse(url).map_err(|e| AgentError::Config {
            message: format!("Invalid URL '{url}': {e}"),
        })?;
        self.base_url = Some(parsed_url);
        Ok(self)
    }

    /// Replace all headers with the provided HeaderMap
    pub fn with_headers(mut self, header_map: HeaderMap) -> Self {
        self.header_map = header_map;
        self
    }

    /// Add a single header by name and value strings
    pub fn with_header(mut self, name: &str, value: &str) -> Result<Self, AgentError> {
        let header_name = HeaderName::from_str(name).map_err(|e| AgentError::Config {
            message: format!("Invalid header name '{value}': {e}"),
        })?;
        let header_value = HeaderValue::from_str(value).map_err(|e| AgentError::Config {
            message: format!("Invalid header value '{value}': {e}"),
        })?;
        self.header_map.insert(header_name, header_value);
        Ok(self)
    }

    /// Add a header using HeaderName and HeaderValue directly
    pub fn with_header_typed(mut self, name: HeaderName, value: HeaderValue) -> Self {
        self.header_map.insert(name, value);
        self
    }

    /// Add an authorization bearer token
    pub fn with_bearer_token(self, token: &str) -> Result<Self, AgentError> {
        let auth_value = format!("Bearer {token}");
        self.with_header("Authorization", &auth_value)
    }

    /// Set a custom HTTP client
    pub fn with_http_client(mut self, client: HttpClient) -> Self {
        self.http_client = Some(client);
        self
    }

    /// Set request timeout in seconds
    pub fn with_timeout(mut self, timeout_secs: u64) -> Self {
        let client = HttpClient::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .build()
            .unwrap_or_else(|_| HttpClient::new());
        self.http_client = Some(client);
        self
    }

    /// Set Agent ID
    pub fn with_agent_id(mut self, agent_id: AgentId) -> Self {
        self.agent_id = Some(agent_id);
        self
    }

    pub fn build(self) -> Result<HttpAgent, AgentError> {
        let base_url = self.base_url.ok_or(AgentError::Config {
            message: "Base URL is required".to_string(),
        })?;

        // Validate URL scheme
        if !["http", "https"].contains(&base_url.scheme()) {
            return Err(AgentError::Config {
                message: format!("Unsupported URL scheme: {}", base_url.scheme()),
            });
        }

        let http_client = self.http_client.unwrap_or_default();

        Ok(HttpAgent {
            http_client,
            base_url,
            header_map: self.header_map,
            agent_id: self.agent_id,
        })
    }
}

impl Default for HttpAgentBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl<StateT, FwdPropsT> Agent<StateT, FwdPropsT> for HttpAgent
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
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

        // Check HTTP status and surface structured error on non-success
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let snippet: String = text.chars().take(512).collect();
            return Err(AgentError::HttpStatus {
                status,
                context: snippet,
            });
        }

        // Convert the response to an SSE event stream
        let stream = response
            .event_source()
            .await
            .map(|result| match result {
                Ok(event) => {
                    trace!("Received event: {event:?}");

                    let event_data: Event<StateT> = serde_json::from_str(&event.data)?;
                    debug!("Deserialized event: {event_data:?}");

                    Ok(event_data)
                }
                Err(err) => Err(err),
            })
            .boxed();
        Ok(stream)
    }

    fn agent_id(&self) -> Option<&AgentId> {
        self.agent_id.as_ref()
    }
}
