use reqwest::StatusCode;
use thiserror::Error;

/// Why bounded HTTP error-body capture stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ErrorBodyStopReason {
    Complete,
    ByteLimit,
    ReadTimeout,
    ReadFailed,
}

/// A bounded response-body prefix, excluded from both `Debug` and `Display`.
///
/// Explicit inspection can reveal secrets echoed by a server. Do not log or
/// forward the returned bytes/text without applying your application's policy.
#[derive(Clone)]
pub struct HttpErrorBody {
    bytes: Vec<u8>,
    stop_reason: ErrorBodyStopReason,
}

impl HttpErrorBody {
    pub(crate) fn new(bytes: Vec<u8>, stop_reason: ErrorBodyStopReason) -> Self {
        Self { bytes, stop_reason }
    }

    /// Inspect the captured prefix without decoding or copying it.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Inspect the captured prefix as UTF-8. Invalid or split code points fail
    /// rather than modifying the captured bytes.
    pub fn text(&self) -> std::result::Result<&str, std::str::Utf8Error> {
        std::str::from_utf8(&self.bytes)
    }

    pub fn stop_reason(&self) -> ErrorBodyStopReason {
        self.stop_reason
    }

    /// Whether capture stopped without observing the body's end. This is
    /// conservative: reaching the byte limit (even exactly) may mean truncation.
    pub fn is_truncated(&self) -> bool {
        self.stop_reason != ErrorBodyStopReason::Complete
    }
}

impl std::fmt::Display for HttpErrorBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = match self.stop_reason {
            ErrorBodyStopReason::Complete => "body ended",
            ErrorBodyStopReason::ByteLimit => "byte limit reached",
            ErrorBodyStopReason::ReadTimeout => "read deadline reached",
            ErrorBodyStopReason::ReadFailed => "body read failed",
        };
        write!(
            f,
            "error body omitted; inspected {} bytes; {reason}",
            self.bytes.len()
        )
    }
}

impl std::fmt::Debug for HttpErrorBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpErrorBody")
            .field("captured_bytes", &self.bytes.len())
            .field("stop_reason", &self.stop_reason)
            .finish_non_exhaustive()
    }
}

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

    /// Non-success HTTP status with an explicitly inspectable, redacted body
    #[error("HTTP status {status}: {context}")]
    HttpStatus {
        status: reqwest::StatusCode,
        context: String,
        body: HttpErrorBody,
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
    /// Inspect a non-success response body. Normal error formatting omits it.
    pub fn http_error_body(&self) -> Option<&HttpErrorBody> {
        match self {
            Self::HttpStatus { body, .. } => Some(body),
            _ => None,
        }
    }

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
