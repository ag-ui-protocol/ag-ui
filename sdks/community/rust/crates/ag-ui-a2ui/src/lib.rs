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
// The bullets below name modules that only exist behind their feature, and a
// doc link to a module that is not compiled is a rustdoc *error*, not a dead
// link — so `cargo doc --no-default-features` failed on this block for as long
// as it existed. Gating the text rather than deleting the links keeps every
// link live in the `--all-features` build that docs.rs and the docs site
// publish, and keeps the feature-off build documentable, which matters because
// that build is exactly what this crate advertises for A2A and MCP. The
// `doc-features` job in CI is what stops it drifting back; nothing caught it
// before, because the docs job only ever ran `--all-features` and the features
// job used `cargo check`, which does not resolve intra-doc links at all.
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
    doc = "  history entries from [`ag_ui::Message`](https://docs.rs/ag-ui/0.4.2/ag_ui/message/enum.Message.html), toolkit tool definitions as",
    doc = "  offerable [`ag_ui::Tool`](https://docs.rs/ag-ui/0.4.2/ag_ui/tool/struct.Tool.html)s."
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

// `readme = "README.md"` in Cargo.toml makes that file the crate's front page
// wherever the package is presented, so its examples are doctested: a stale one
// is a red build rather than a bad first impression. `cfg(doctest)` is what
// keeps this module out of the rendered docs — it compiles the examples rather
// than publishing them.
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

// The front door: what a caller producing or checking A2UI reaches for first.
// Everything else stays behind its module, because the modules are the map.
pub use catalog::Catalog;
pub use error::{Error, Result, ValidationErrors};
pub use message::{
    AgentMessage, AgentPayload, ChildList, ChildTemplate, Component, RendererMessage,
    RendererPayload,
};
pub use validate::{ErrorCode, ValidateOptions, ValidationError, ValidationReport, Validator};

#[cfg(feature = "toolkit")]
pub use toolkit::{StreamParser, wrap_as_operations_envelope, wrap_error_envelope};

#[cfg(feature = "ag-ui")]
pub use agui::find_prior_surface_in;
