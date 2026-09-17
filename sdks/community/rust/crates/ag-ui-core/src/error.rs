use thiserror::Error;

impl AgUiError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl From<serde_json::Error> for AgUiError {
    fn from(err: serde_json::Error) -> Self {
        let msg = format!("Failed to parse JSON: {err}");
        Self::new(msg)
    }
}

#[derive(Error, Debug)]
#[error("AG-UI Error: {message}")]
pub struct AgUiError {
    pub message: String,
}

pub type Result<T> = std::result::Result<T, AgUiError>;
