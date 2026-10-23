//! A2UI protocol types, semantic validator, and agent-side authoring toolkit.
//!
//! [A2UI](https://a2ui.org) is a declarative, agent-driven UI protocol: an agent
//! streams JSON describing a surface, and a renderer draws it. This crate is the
//! **agent half** of that exchange.
//!
//! # This crate does not render
//!
//! Nothing here draws pixels, lays out a tree, or evaluates a UI at runtime. It
//! produces A2UI, validates it, and transports it. Rendering is the client's
//! job, and it is a genuinely different program — one with a widget toolkit, an
//! event loop, and a reactive data model. What this crate gives you instead:
//!
//! - [`message`] — the v0.9-family protocol envelopes, in both directions.
//! - [`catalog`] — what a surface may contain, including the standard
//!   18-component basic catalog.
//! - [`validate`] — the semantic checks JSON Schema cannot express: does every
//!   child reference resolve, is there a root, is the tree acyclic. Plus the two
//!   a generating model gets wrong often enough to be worth checking without a
//!   schema engine: the message envelope, and property values against the type
//!   the catalog declares.
//! - [`binding`] — JSON Pointer resolution, template scopes, and the
//!   `formatString` interpolation grammar, so an agent can check its own
//!   bindings before shipping them.
// Gate module links with their features so minimal rustdoc builds resolve them.
#![cfg_attr(
    feature = "toolkit",
    doc = "- [`toolkit`] (feature `toolkit`) — building ops, negotiating a catalog,",
    doc = "  assembling prompts, parsing a model's output as it streams, recovering a",
    doc = "  surface from conversation history, and the validate-and-retry loop around",
    doc = "  a generating model."
)]
#![cfg_attr(
    feature = "ag-ui",
    doc = "- [`agui`] (feature `ag-ui`) — the glue for an agent hosted on AG-UI:",
    doc = "  history entries from `ag_ui::Message`, toolkit tool definitions as",
    doc = "  offerable `ag_ui::Tool`s."
)]
//!
//! # Transport
//!
//! A2UI says nothing about how messages reach the renderer, and everything
//! outside one module keeps it that way — turn the `ag-ui` feature off and the
//! dependency goes with it, leaving a crate you can drive over A2A or MCP. That
//! module is
#![cfg_attr(feature = "ag-ui", doc = "[`agui`].")]
#![cfg_attr(
    not(feature = "ag-ui"),
    doc = "`agui`, and this build does not have it."
)]
//! The optional AG-UI integration wraps a batch of operations in a
//! `{"a2ui_operations": [...]}` envelope and let the frontend sniff for that
//! key.
#![cfg_attr(
    feature = "toolkit",
    doc = "[`toolkit::envelope`] produces exactly that, as a plain JSON string that",
    doc = "fits in an AG-UI assistant message, an A2A data part, or an MCP tool result",
    doc = "without further wrapping."
)]
//!
//! # Conformance
//!
//! The A2UI project publishes a language-agnostic conformance suite as YAML.
//! It is vendored under `tests/conformance/` and run as a normal test; the
//! report prints what passed, what was skipped, and why. See the README there
//! for the current standing.
//!
//! # Version
//!
//! Supports `v0.9` and `v0.9.1`. Low-level constructors retain `v0.9` as
//! their default; use `A2uiVersion` to select a discriminator. Candidate RPC
//! payloads are not accepted or serialized as v0.9-family messages.
//!
//! # Example
//!
//! ```
//! use ag_ui_a2ui::{Catalog, Component, Validator};
//! use serde_json::json;
//!
//! let catalog = Catalog::basic();
//! let components = vec![
//!     Component::new("root", "Card").with("child", json!("greeting")),
//!     Component::new("greeting", "Text").with("text", json!("Hello!")),
//! ];
//!
//! let report = Validator::new(&catalog).validate(&components);
//! assert!(report.is_valid());
//! ```

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(missing_debug_implementations)]
// See `ag_ui`'s lib.rs: marks feature-gated items in the rendered docs.
#![cfg_attr(docsrs, feature(doc_cfg))]

// Keep README examples covered by doctests.
#[cfg(doctest)]
#[doc = include_str!("../README.md")]
mod readme {}

pub mod binding;
pub mod catalog;
pub mod constants;
pub mod error;
pub mod message;
pub mod model;
pub mod surface;

#[cfg(feature = "author")]
pub mod author;
#[cfg(feature = "schema-validation")]
pub mod client_schema;
#[cfg(feature = "schema-validation")]
pub mod schema_validation;
#[cfg(feature = "author")]
pub use author::{A2uiAuthor, AuthorRequest, ValidatedSurface};
pub use message::{A2uiVersion, DataModelUpdate};
pub use model::{DataModel, ModelValue};
pub mod validate;

#[cfg(feature = "toolkit")]
pub mod toolkit;

#[cfg(feature = "ag-ui")]
pub mod agui;

pub use catalog::Catalog;
pub use error::{Error, Result, ValidationErrors};
pub use message::{
    AgentMessage, AgentPayload, ChildList, ChildTemplate, ClientDataModel, Component,
    RendererMessage, RendererPayload,
};
pub use validate::{ErrorCode, ValidateOptions, ValidationError, ValidationReport, Validator};

#[cfg(feature = "toolkit")]
pub use toolkit::{StreamParser, wrap_as_operations_envelope, wrap_error_envelope};

#[cfg(feature = "ag-ui")]
pub use agui::find_prior_surface_in;
