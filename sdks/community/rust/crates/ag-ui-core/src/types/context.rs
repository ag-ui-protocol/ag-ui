use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Context {
    /// A description of the context item
    pub description: String,
    /// The value of the context item
    pub value: String,
}

impl Context {
    pub fn new(description: String, value: String) -> Self {
        Self { description, value }
    }
}
