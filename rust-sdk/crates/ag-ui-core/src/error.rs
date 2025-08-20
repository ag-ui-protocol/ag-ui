use thiserror::Error;

impl AguiError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl From<serde_json::Error> for AguiError {
    fn from(err: serde_json::Error) -> Self {
        let msg = format!("Failed to parse JSON: {err}");
        Self::new(msg)
    }
}

#[derive(Error, Debug)]
#[error("AG-UI Error: {message}")]
pub struct AguiError {
    pub message: String,
}

pub type Result<T> = std::result::Result<T, AguiError>;
