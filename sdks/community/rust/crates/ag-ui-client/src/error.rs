use reqwest::StatusCode;
use thiserror::Error;

/// Ag-ui client errors
#[derive(Error, Debug)]
#[non_exhaustive]
pub enum AgUiClientError {
    /// Configuration/usage errors
    #[error("Invalid configuration: {message}")]
    Config { message: String },

    /// Transport-level HTTP failures from reqwest
    #[error("HTTP transport error: {0}")]
    HttpTransport(reqwest::Error),

    /// Transport failed after response headers; retry could duplicate a server run.
    #[error("HTTP streaming transport error: {0}")]
    StreamingTransport(reqwest::Error),

    /// Non-success HTTP status with bounded receipt metadata, never body contents
    #[error("HTTP status {status}: {context}")]
    HttpStatus {
        status: reqwest::StatusCode,
        context: String,
    },

    /// SSE parsing/framing/UTF-8 errors
    #[error("SSE parse error: {message}")]
    SseParse { message: String },

    /// Malformed or terminally incomplete UTF-8. No payload bytes are included.
    #[error("SSE invalid UTF-8 (incomplete code point: {incomplete})")]
    SseInvalidUtf8 { incomplete: bool },

    #[error("SSE ended before a complete frame delimiter")]
    SseTruncated,

    #[error("SSE {kind} exceeds the configured {limit}-byte limit")]
    SseLimitExceeded { kind: &'static str, limit: usize },

    #[error("HTTP response must have Content-Type text/event-stream")]
    UnexpectedContentType,

    #[error("Protocol processing failed: {0}")]
    Processing(#[from] ag_ui_core::processing::ProcessingError),

    #[error("Exchange identity mismatch: {0}")]
    ExchangeIdentity(String),

    #[error("Incomplete run: {0}")]
    IncompleteRun(String),

    /// JSON serialization/deserialization errors
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// Errors from subscribers/callbacks
    #[error("Subscriber error: {message}")]
    Subscriber { message: String },

    /// Pipeline catch-all
    #[error("Agent execution error: {message}")]
    Execution { message: String },
}

impl AgUiClientError {
    pub fn config(m: impl Into<String>) -> Self {
        Self::Config { message: m.into() }
    }
    pub fn exec(m: impl Into<String>) -> Self {
        Self::Execution { message: m.into() }
    }

    /// Whether or not the error is retryable.
    /// Generally, the request is considered retryable if the following errors are received:
    /// - Connection errors
    /// - Internal server errors
    /// - Errors related to too many requests (ie, rate limiting or throttling)
    ///
    /// Timeouts and streaming failures may follow a server-side commit and are not retried.
    pub fn is_retryable(&self) -> bool {
        match self {
            AgUiClientError::HttpTransport(e) => e.is_connect(),
            AgUiClientError::HttpStatus { status, .. } => {
                status.is_server_error() || *status == StatusCode::TOO_MANY_REQUESTS
            }
            _ => false,
        }
    }

    pub fn is_user_input(&self) -> bool {
        matches!(self, AgUiClientError::Config { .. })
    }
}

pub type Result<T> = std::result::Result<T, AgUiClientError>;

// reqwest errors can contain the URL, including query credentials. Never retain it.
impl From<reqwest::Error> for AgUiClientError {
    fn from(error: reqwest::Error) -> Self {
        Self::HttpTransport(error.without_url())
    }
}
