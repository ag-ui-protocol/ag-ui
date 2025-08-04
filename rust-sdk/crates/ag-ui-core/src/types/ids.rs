use uuid::Uuid;
use serde::{Deserialize, Serialize};

/// Agent ID
///
/// A newtype is used to prevent mixing them with other ID values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentId(Uuid);

impl AgentId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl From<Uuid> for AgentId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

/// Thread ID
///
/// A newtype is used to prevent mixing them with other ID values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadId(Uuid);

impl ThreadId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl From<Uuid> for ThreadId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunId(Uuid);

/// Run ID
///
/// A newtype is used to prevent mixing them with other ID values.
impl RunId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl From<Uuid> for RunId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

/// Tool Call ID
///
/// A newtype is used to prevent mixing them with other ID values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCallId(Uuid);

impl ToolCallId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl From<Uuid> for ToolCallId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}