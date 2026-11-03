//! HTTP/SSE transport. Every request passes the same strict outgoing projection.
use crate::Agent;
use crate::agent::AgentError;
use crate::core::event::Event;
use crate::core::types::RunAgentInput;
use crate::core::{AgentState, FwdProps};
use crate::sse::{SseLimits, SseResponseExt};
use crate::stream::EventStream;
use ag_ui_core::processing::{Diagnostic, prepare_run_input};
use ag_ui_core::types::AgentId;
use async_trait::async_trait;
use futures::StreamExt;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client as HttpClient, Url};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

type DiagnosticHandler = Arc<dyn Fn(&Diagnostic) + Send + Sync>;

/// Bounds for non-success body receipt, not just display truncation.
///
/// Body text is deliberately excluded from errors: a server can echo arbitrary
/// request secrets. Status, inspected byte count, and the stopping reason remain.
#[derive(Debug, Clone, Copy)]
pub struct ErrorBodyLimits {
    pub max_bytes: usize,
    pub read_timeout: Duration,
}

impl Default for ErrorBodyLimits {
    fn default() -> Self {
        Self {
            max_bytes: 64 * 1024,
            read_timeout: Duration::from_secs(2),
        }
    }
}

/// An HTTP/SSE-only agent. Accept and Content-Type are set by the transport even
/// when custom headers contain conflicting values. Raw `Agent::run` returns events
/// without verifying run completion; use `Agent::run_input` for lifecycle results.
pub struct HttpAgent {
    http_client: HttpClient,
    base_url: Url,
    header_map: HeaderMap,
    agent_id: Option<AgentId>,
    request_timeout: Option<Duration>,
    sse_limits: SseLimits,
    error_body_limits: ErrorBodyLimits,
    diagnostic_handler: Option<DiagnosticHandler>,
}

impl HttpAgent {
    pub fn new(base_url: Url, header_map: HeaderMap) -> Self {
        Self {
            http_client: HttpClient::new(),
            base_url,
            header_map,
            agent_id: None,
            request_timeout: None,
            sse_limits: SseLimits::default(),
            error_body_limits: ErrorBodyLimits::default(),
            diagnostic_handler: None,
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
    request_timeout: Option<Duration>,
    sse_limits: SseLimits,
    error_body_limits: ErrorBodyLimits,
    diagnostic_handler: Option<DiagnosticHandler>,
}

impl HttpAgentBuilder {
    pub fn new() -> Self {
        Self {
            base_url: None,
            header_map: HeaderMap::new(),
            http_client: None,
            agent_id: None,
            request_timeout: None,
            sse_limits: SseLimits::default(),
            error_body_limits: ErrorBodyLimits::default(),
            diagnostic_handler: None,
        }
    }

    pub fn with_url(mut self, base_url: Url) -> Self {
        self.base_url = Some(base_url);
        self
    }

    pub fn with_url_str(mut self, url: &str) -> Result<Self, AgentError> {
        self.base_url = Some(Url::parse(url).map_err(|_| AgentError::config("Invalid URL"))?);
        Ok(self)
    }

    pub fn with_headers(mut self, header_map: HeaderMap) -> Self {
        self.header_map = header_map;
        self
    }

    /// Header names and values are never included in construction errors.
    pub fn with_header(mut self, name: &str, value: &str) -> Result<Self, AgentError> {
        let name =
            HeaderName::from_str(name).map_err(|_| AgentError::config("Invalid header name"))?;
        let value =
            HeaderValue::from_str(value).map_err(|_| AgentError::config("Invalid header value"))?;
        self.header_map.insert(name, value);
        Ok(self)
    }

    pub fn with_header_typed(mut self, name: HeaderName, value: HeaderValue) -> Self {
        self.header_map.insert(name, value);
        self
    }

    pub fn with_bearer_token(self, token: &str) -> Result<Self, AgentError> {
        self.with_header("Authorization", &format!("Bearer {token}"))
    }

    pub fn with_http_client(mut self, client: HttpClient) -> Self {
        self.http_client = Some(client);
        self
    }

    /// Set a deadline for the complete HTTP exchange, including the streamed run.
    /// Expiration after response headers is never classified as safe to retry.
    /// Use `with_http_client` for custom connection and idle-read timeouts.
    pub fn with_timeout(mut self, timeout_secs: u64) -> Self {
        self.request_timeout = Some(Duration::from_secs(timeout_secs));
        self
    }

    pub fn with_agent_id(mut self, agent_id: AgentId) -> Self {
        self.agent_id = Some(agent_id);
        self
    }

    pub fn with_sse_limits(mut self, limits: SseLimits) -> Self {
        self.sse_limits = limits;
        self
    }

    pub fn with_error_body_limits(mut self, limits: ErrorBodyLimits) -> Self {
        self.error_body_limits = limits;
        self
    }

    /// Observe bounded, structured normalization diagnostics without logging payloads.
    pub fn with_diagnostic_handler(
        mut self,
        handler: impl Fn(&Diagnostic) + Send + Sync + 'static,
    ) -> Self {
        self.diagnostic_handler = Some(Arc::new(handler));
        self
    }

    pub fn build(self) -> Result<HttpAgent, AgentError> {
        let base_url = self
            .base_url
            .ok_or_else(|| AgentError::config("Base URL is required"))?;
        if !["http", "https"].contains(&base_url.scheme()) {
            return Err(AgentError::config("Unsupported URL scheme"));
        }
        Ok(HttpAgent {
            http_client: self.http_client.unwrap_or_default(),
            base_url,
            header_map: self.header_map,
            agent_id: self.agent_id,
            request_timeout: self.request_timeout,
            sse_limits: self.sse_limits,
            error_body_limits: self.error_body_limits,
            diagnostic_handler: self.diagnostic_handler,
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
        // Validate and project immediately before POST, including this low-level route.
        let processed = prepare_run_input(input)?;
        for diagnostic in &processed.diagnostics {
            if let Some(handler) = &self.diagnostic_handler {
                handler(diagnostic);
            }
        }
        let mut headers = self.header_map.clone();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
        let mut request = self
            .http_client
            .post(self.base_url.clone())
            .json(&processed.input)
            .headers(headers);
        if let Some(timeout) = self.request_timeout {
            request = request.timeout(timeout);
        }
        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            return Err(AgentError::HttpStatus {
                status,
                context: bounded_error_context(response, self.error_body_limits).await,
            });
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<mime::Mime>().ok());
        if !content_type
            .is_some_and(|value| value.type_() == mime::TEXT && value.subtype() == "event-stream")
        {
            return Err(AgentError::UnexpectedContentType);
        }
        let handler = self.diagnostic_handler.clone();
        let source = response.event_source_with_limits(self.sse_limits).await;
        // try_unfold drops the HTTP source on every terminal parse/processing
        // failure, even when the caller retains the now-completed raw stream.
        let compatibility = ag_ui_core::compatibility::CompatibilityBoundary::default();
        let stream = futures::stream::try_unfold(
            (source, compatibility),
            move |(mut source, mut compatibility)| {
                let handler = handler.clone();
                async move {
                    while let Some(result) = source.next().await {
                        let frame = result.map_err(|error| match error {
                            AgentError::HttpTransport(error) => {
                                AgentError::StreamingTransport(error)
                            }
                            other => other,
                        })?;
                        if let Some(event) = parse_event_data_with_diagnostics::<StateT>(
                            &frame.data,
                            handler.as_ref(),
                            &mut compatibility,
                        ) {
                            return event.map(|event| Some((event, (source, compatibility))));
                        }
                    }
                    Ok(None)
                }
            },
        )
        .boxed();
        Ok(stream)
    }

    fn agent_id(&self) -> Option<&AgentId> {
        self.agent_id.as_ref()
    }
}

async fn bounded_error_context(response: reqwest::Response, limits: ErrorBodyLimits) -> String {
    let mut source = response.bytes_stream();
    let deadline = tokio::time::Instant::now() + limits.read_timeout;
    let mut inspected = 0;
    let reason = loop {
        if inspected >= limits.max_bytes {
            break "byte limit reached";
        }
        match tokio::time::timeout_at(deadline, source.next()).await {
            Err(_) => break "read deadline reached",
            Ok(None) => break "body ended",
            Ok(Some(Err(_))) => break "body read failed",
            Ok(Some(Ok(chunk))) => {
                inspected += chunk.len().min(limits.max_bytes - inspected);
            }
        }
    };
    format!("error body omitted; inspected {inspected} bytes; {reason}")
}

fn parse_event_data_with_diagnostics<StateT: AgentState>(
    data: &str,
    handler: Option<&DiagnosticHandler>,
    compatibility: &mut ag_ui_core::compatibility::CompatibilityBoundary,
) -> Option<Result<Event<StateT>, AgentError>> {
    let raw: serde_json::Value = match serde_json::from_str(data) {
        Ok(raw) => raw,
        Err(error) => return Some(Err(error.into())),
    };
    let processed = match compatibility.normalize_event::<StateT>(raw) {
        Ok(processed) => processed,
        Err(error) => return Some(Err(error.into())),
    };
    for diagnostic in &processed.diagnostics {
        if let Some(handler) = handler {
            handler(diagnostic);
        }
    }
    processed.event.map(Ok)
}
