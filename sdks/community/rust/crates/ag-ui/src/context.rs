//! Additional context handed to an agent alongside the messages.

use serde::{Deserialize, Serialize};

/// One piece of ambient context for a run.
///
/// Contexts are free-form label/value pairs — the current page a user is on,
/// a selected record, a feature flag — that the agent may fold into its prompt
/// without them appearing as conversation messages.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct Context {
    /// What this value is, in words the model can use.
    pub description: String,
    /// The value itself, already rendered to a string.
    pub value: String,
}

impl Context {
    /// Builds a context entry.
    pub fn new(description: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            description: description.into(),
            value: value.into(),
        }
    }
}
