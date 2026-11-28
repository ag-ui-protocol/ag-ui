//! The event surface extracted from the normative protocol schema.

use std::collections::BTreeMap;

/// One wire field, with the schema's requiredness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub name: String,
    pub required: bool,
    pub kind: String,
}

/// One event type and its payload fields.
#[derive(Debug, Clone)]
pub struct UpstreamEvent {
    pub event_type: String,
    pub schema: Option<String>,
    /// Excludes the `type` discriminator and inherited `BaseEvent` fields.
    pub fields: Vec<Field>,
    pub unparsed: Option<String>,
}

/// The complete schema event surface in declaration order.
#[derive(Debug, Clone)]
pub struct Upstream {
    pub event_types: Vec<String>,
    pub base_fields: Vec<Field>,
    pub events: Vec<UpstreamEvent>,
    /// Root validation keywords, excluding `$defs`, whose shapes are recorded
    /// separately below. Adjacent root constraints can change every event.
    pub root_signature: String,
    /// Stable fingerprints of every normative `$defs` shape, including nested
    /// unions and field types that the Rust text scanner cannot classify.
    pub schema_signatures: BTreeMap<String, String>,
    pub notes: Vec<String>,
}
