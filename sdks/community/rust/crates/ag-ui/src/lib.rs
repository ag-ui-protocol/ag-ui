//! A Rust SDK for the [AG-UI protocol] — hosting an agent and consuming one.
//!
//! AG-UI is the protocol between a user-facing application and an agent
//! backend. A run is a stream of [`Event`]s: the agent opens messages, streams
//! text and reasoning, calls tools, publishes state, and finishes — or pauses
//! for human input.
//!
//! Imported for review as a proposed unified community Rust SDK. The event
//! surface is checked against the TypeScript definitions in this checkout.
//! See the Rust workspace's migration guide for differences from the previously published
//! `ag-ui-core` and `ag-ui-client` packages.
//!
//! # What is in the box
//!
//! The crate root is the shared vocabulary: the types, their exact JSON
//! representation, and the SSE framing that carries them. No runtime, no I/O,
//! no async — that part compiles for everyone.
//!
//! Everything past it is a feature, because most programs want one side of the
//! protocol and should not pay to compile the other. Each entry below is
//! gated the same way its module is: a link to an item this build does not
//! have is a rustdoc error, not a dead link, which is what the `doc-features`
//! CI job exists to catch.
//!
#![cfg_attr(
    feature = "server",
    doc = "- [`server`] — host an agent. Implement [`server::Agent`], hand it to",
    doc = "  [`server::run()`], and you have a stream a transport can serialize."
)]
#![cfg_attr(
    not(feature = "server"),
    doc = "- `server` *(off in this build)* — host an agent: the `Agent` trait, and",
    doc = "  `run()` to turn one into a stream a transport can serialize."
)]
#![cfg_attr(
    feature = "client",
    doc = "- [`client`] — consume a remote agent, materializing its events into",
    doc = "  messages and state."
)]
#![cfg_attr(
    not(feature = "client"),
    doc = "- `client` *(off in this build)* — consume a remote agent, materializing",
    doc = "  its events into messages and state."
)]
#![cfg_attr(
    feature = "axum",
    doc = "- [`axum`] — mount a hosted agent on an axum router, one call."
)]
#![cfg_attr(
    not(feature = "axum"),
    doc = "- `axum` *(off in this build)* — mount a hosted agent on an axum router."
)]
//!
//! Each runtime keeps its own `Error` and `Result` under its own module. A
//! bare [`Error`] is always a protocol error, `ag_ui::server::Error` is a
//! hosting error, and collapsing them into the root would hide a distinction
//! that matters at every `?`.
//!
//! ```
//! # #[cfg(feature = "sse")] {
//! use ag_ui::{Event, EventStreamFormatter, SseFormatter, TextMessageRole};
//!
//! let formatter = SseFormatter::new();
//! let run = [
//!     Event::run_started("thread-1", "run-1"),
//!     Event::text_message_start("msg-1", TextMessageRole::Assistant),
//!     Event::text_message_content("msg-1", "Hello"),
//!     Event::text_message_end("msg-1"),
//!     Event::run_finished_success("thread-1", "run-1"),
//! ];
//!
//! let body: String = run
//!     .iter()
//!     .map(|event| formatter.encode_to_string(event).unwrap())
//!     .collect();
//!
//! assert!(body.starts_with(r#"data: {"type":"RUN_STARTED","threadId":"thread-1""#));
//! # }
//! ```
//!
//! # Identifiers are strings
//!
//! [`ThreadId`], [`RunId`] and friends wrap [`String`], not `Uuid`. Producers
//! send arbitrary strings and a stricter type would reject valid traffic — see
//! the [`ids`] module for the history.
//!
//! # Features
//!
// A feature list is the one place a doc link is guaranteed to name something
// the current build may not have. Gated so the link stays live where the item
// exists — see `doc-features` in CI.
#![cfg_attr(
    feature = "sse",
    doc = "- `sse` *(default)* — [`SseFormatter`] and `text/event-stream` framing."
)]
#![cfg_attr(
    not(feature = "sse"),
    doc = "- `sse` *(default, off in this build)* — `SseFormatter` and `text/event-stream` framing."
)]
//! - `protobuf` — the binary transport's media type and a documented stub; the
//!   `encode::protobuf` module explains why there is no encoder.
//! - `schemars` — derives `schemars::JsonSchema` on the public types.
//! - `utoipa` — derives `utoipa::ToSchema` on the public types.
//! - `server` — the server runtime: the agent trait, typestate emitters, state
//!   deltas. Executor-agnostic; no tokio.
//! - `verify` *(default)* — `server`'s ordering state machine. Off, the whole
//!   verifier is a zero-sized type whose checks compile away. Listed in
//!   `default` rather than implied by `server` so `default-features = false`
//!   can drop it.
//! - `client` — the client runtime, transport-agnostic.
//! - `http` — adds the reqwest-backed transport to `client`. What most
//!   consumers want; leave it off for wasm or a custom transport.
//! - `axum` — mounts a hosted agent on an axum router. Implies `server` and
//!   `sse`, and is the one feature that pulls in tokio.
//!
//! ```toml
//! [dependencies]
//! # host an agent behind axum
//! ag-ui = { version = "0.3", features = ["axum"] }
//! # or consume one over HTTP
//! ag-ui = { version = "0.3", features = ["http"] }
//! ```
//!
//! [AG-UI protocol]: https://github.com/ag-ui-protocol/ag-ui

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(missing_debug_implementations)]
// Stamps "Available on crate feature X" on every gated item in the rendered
// docs. Only ever set by docs.rs and the `cargo doc` recipe in CONTRIBUTING, so
// it costs a stable build nothing.
#![cfg_attr(docsrs, feature(doc_cfg))]

// `readme = "README.md"` in Cargo.toml makes that file the crate's front page
// wherever the package is presented, so its examples are doctested: a stale one
// is a red build rather than a bad first impression. `cfg(doctest)` is what
// keeps this module out of the rendered docs — it compiles the examples rather
// than publishing them.
// Gated on `sse` because that is the feature the example demonstrates.
#[cfg(all(doctest, feature = "sse"))]
#[doc = include_str!("../README.md")]
mod readme {}

pub mod capabilities;
pub mod context;
pub mod error;
pub mod event;
pub mod ids;
pub mod input;
pub mod message;
pub mod metadata;
pub mod outcome;
pub mod patch;
pub mod token_usage;
pub mod tool;

mod serde_util;

#[cfg(any(feature = "sse", feature = "protobuf"))]
pub mod encode;

// The runtimes. Each carries its own `Error` and `Result`, which is why they
// stay behind a module path instead of being flattened into the root the way
// the protocol types are: `ag_ui::Error` is a protocol error, `ag_ui::server::Error`
// is a hosting error, and collapsing them would make the distinction invisible.
#[cfg(feature = "axum")]
pub mod axum;
#[cfg(feature = "client")]
pub mod client;
#[cfg(feature = "server")]
pub mod server;

/// A JSON object — the Rust spelling of TypeScript's `Record<string, any>`.
///
/// Key order is preserved, so a payload that round-trips through this crate
/// comes back out in the order it arrived.
pub type JsonObject = serde_json::Map<String, serde_json::Value>;

pub use capabilities::{
    AgentCapabilities, ExecutionCapabilities, HumanInTheLoopCapabilities, IdentityCapabilities,
    MultiAgentCapabilities, MultimodalCapabilities, MultimodalInputCapabilities,
    MultimodalOutputCapabilities, OutputCapabilities, ReasoningCapabilities, StateCapabilities,
    SubAgentInfo, ToolsCapabilities, TransportCapabilities,
};
pub use context::Context;
pub use error::{Error, Result};
pub use event::{
    ActivityDeltaEvent, ActivitySnapshotEvent, BaseEvent, CustomEvent, Event, EventType,
    MessagesSnapshotEvent, RawEvent, ReasoningEncryptedValueEvent, ReasoningEncryptedValueSubtype,
    ReasoningEndEvent, ReasoningMessageChunkEvent, ReasoningMessageContentEvent,
    ReasoningMessageEndEvent, ReasoningMessageStartEvent, ReasoningRole, ReasoningStartEvent,
    RunErrorEvent, RunFinishedEvent, RunStartedEvent, StateDeltaEvent, StateSnapshotEvent,
    StepFinishedEvent, StepStartedEvent, SubagentErrorEvent, SubagentFinishedEvent,
    SubagentOutcome, SubagentStartedEvent, TextMessageChunkEvent, TextMessageContentEvent,
    TextMessageEndEvent, TextMessageRole, TextMessageStartEvent, ToolCallArgsEvent,
    ToolCallChunkEvent, ToolCallEndEvent, ToolCallResultEvent, ToolCallStartEvent, ToolResultRole,
};
// Still part of the protocol, so still re-exported; downstream users get the
// deprecation warning at their use site, not here.
#[allow(deprecated)]
pub use event::{
    ThinkingEndEvent, ThinkingStartEvent, ThinkingTextMessageContentEvent,
    ThinkingTextMessageEndEvent, ThinkingTextMessageStartEvent,
};
pub use ids::{AgentId, MessageId, RunId, StepName, SubagentRunId, ThreadId, ToolCallId};
pub use input::RunAgentInput;
pub use message::{
    ActivityMessage, AssistantMessage, BinaryInputContent, DeveloperMessage, InputContent,
    InputContentSource, MediaInputContent, Message, ReasoningMessage, Role, SystemMessage,
    TextInputContent, ToolMessage, UserContent, UserMessage,
};
pub use metadata::{AGUI_METADATA_KEY, merge_metadata};
pub use outcome::{Interrupt, ResumeEntry, ResumeStatus, RunOutcome};
pub use patch::{JsonPatch, PatchOperation};
pub use token_usage::{TokenUsage, aggregate_token_usage};
pub use tool::{FunctionCall, Tool, ToolCall, ToolCallKind};

#[cfg(feature = "protobuf")]
pub use encode::protobuf::ProtobufFormatter;
#[cfg(feature = "sse")]
pub use encode::sse::SseFormatter;
#[cfg(any(feature = "sse", feature = "protobuf"))]
pub use encode::{
    EventStreamFormatter, PROTOBUF_MEDIA_TYPE, SSE_MEDIA_TYPE, media_type, supported_media_types,
};
