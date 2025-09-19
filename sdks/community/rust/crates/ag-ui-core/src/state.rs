use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::fmt::Debug;

/// Trait bounds for agent's state
pub trait AgentState:
    'static + Debug + Clone + Send + Sync + for<'de> Deserialize<'de> + Serialize + Default
{
}

impl AgentState for JsonValue {}
impl AgentState for () {}

/// Trait bounds for forwarded props
pub trait FwdProps:
    'static + Clone + Send + Sync + for<'de> Deserialize<'de> + Serialize + Default
{
}

impl FwdProps for JsonValue {}
impl FwdProps for () {}
