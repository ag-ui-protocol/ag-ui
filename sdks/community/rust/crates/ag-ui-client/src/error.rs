use reqwest::StatusCode;
use thiserror::Error;

#[derive(Error, Debug)]
#[non_exhaustive]
pub enum AgUiClientError {
    /// Configuration/usage errors
    #[error("Invalid configuration: {message}")]
    Config { message: String },

    /// Transport-level HTTP failures from reqwest
    #[error("HTTP transport error: {0}")]
    HttpTransport(#[from] reqwest::Error),

    /// Non-success HTTP status with body snippet
    #[error("HTTP status {status}: {context}")]
    HttpStatus {
        status: reqwest::StatusCode,
        context: String,
    },

    /// SSE parsing/framing/UTF-8 errors
    #[error("SSE parse error: {message}")]
    SseParse { message: String },

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

    pub fn is_retryable(&self) -> bool {
        match self {
            AgUiClientError::HttpTransport(e) => e.is_connect() || e.is_timeout() || e.is_request(),
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
