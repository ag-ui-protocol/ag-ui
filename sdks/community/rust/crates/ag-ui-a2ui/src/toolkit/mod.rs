//! Agent-side authoring: producing A2UI, not rendering it (feature `toolkit`).
//!
//! Everything an agent needs between "the user asked for a UI" and "valid A2UI
//! is on the wire":
//!
//! | Module | Job |
//! |---|---|
//! | [`negotiate`] | Agree with the renderer on which catalog the surface speaks. |
//! | [`ops`] | Build the operation stream, skipping `createSurface` on update. |
//! | [`envelope`] | Wrap operations for transport, or report a failure. |
//! | [`prompt`] | Assemble the generating model's prompt from catalog, context, and current surface. |
//! | [`parser`] | Pull A2UI blocks back out of the model's response. |
//! | [`streaming`] | Do the same incrementally, so a surface renders while it is still being generated. |
//! | [`history`] | Recover a previously rendered surface so it can be edited. |
//! | [`recovery`] | Validate, feed the errors back, retry — up to three times. |
//! | [`schema`] | Hold the three schema documents; prune them to what the model needs. |
//! | [`tools`] | The `generate_a2ui` and `render_a2ui` tool definitions. |
//!
//! # The loop these compose into
//!
//! ```text
//!   history::find_prior_surface  ─┐
//!   catalog::Catalog             ─┼─▶ prompt::build_subagent_prompt
//!   the user's request           ─┘             │
//!                                               ▼
//!                                        the model
//!                                               │
//!                                  parser::parse_response
//!                                               │
//!                                    validate::Validator
//!                                     ┌─────────┴─────────┐
//!                                  valid              invalid
//!                                     │                   │
//!                          ops::assemble_ops   prompt::augment_prompt_with_errors
//!                                     │                   │
//!                 envelope::wrap_as_operations_envelope   retry (max 3)
//! ```
//!
//! [`recovery::generate_with_recovery`] runs the middle of that diagram for you;
//! the rest is there so you can assemble a different shape if your agent needs
//! one.
//!
//! # Streaming is the other shape
//!
//! That loop waits for the whole generation before anything reaches the user,
//! which trades latency for a validate-and-retry safety net. Swap
//! [`parser::parse_response`] for [`streaming::StreamParser`] and the surface
//! renders as it is generated instead: partial trees are emitted with
//! placeholders for components still on the wire, and validation becomes a
//! filter that holds fragments back rather than a gate that retries. Pick the
//! first when correctness matters more than latency, the second when the user
//! is watching.

pub mod envelope;
pub mod history;
pub mod negotiate;
pub mod ops;
pub mod parser;
pub mod prompt;
pub mod recovery;
pub mod schema;
pub mod streaming;
pub mod tools;

pub use envelope::{wrap_as_operations_envelope, wrap_error_envelope};
pub use history::{
    HistoryMessage, PriorSurface, find_prior_surface, try_find_prior_surface,
    try_find_prior_surface_by_id,
};
pub use negotiate::{CatalogRegistry, ClientCapabilities, ClientCapabilitiesWire, select_catalog};
pub use ops::{Intent, SurfaceSpec, assemble_ops};
pub use recovery::{
    RecoveredSurface, RecoveryActivity, RecoveryOptions, generate_with_recovery,
    generate_with_recovery_async,
};
pub use schema::SchemaBundle;
pub use streaming::StreamParser;
pub use tools::{ToolDefinition, generate_a2ui_tool, render_a2ui_tool};
