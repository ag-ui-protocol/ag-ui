pub mod error;
pub mod event;
pub mod types;

pub use error::{AguiError, Result};
use serde::{Deserialize, Serialize};
/// Re-export to ensure the same type is used
pub use serde_json::Value as JsonValue;
use std::fmt::Debug;

pub trait AgentState:
    'static + Debug + Clone + Send + Sync + for<'de> Deserialize<'de> + Serialize
{}
impl AgentState for JsonValue {}

pub trait FwdProps: 'static + Clone + Send + Sync + for<'de> Deserialize<'de> + Serialize {}
impl FwdProps for JsonValue {}
