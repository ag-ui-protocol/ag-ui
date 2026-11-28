#![doc = include_str!("../README.md")]

pub mod compatibility;
pub mod error;
pub mod event;
pub mod history;
pub mod patch;
pub mod processing;
mod state;
pub mod types;

pub use error::{AgUiError, Result};
pub use state::{AgentState, FwdProps};

/// Re-export to ensure the same type is used
pub use serde_json::Value as JsonValue;
