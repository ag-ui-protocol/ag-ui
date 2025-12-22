#![doc = include_str!("../README.md")]

pub mod agent;
pub mod error;
pub mod event_handler;
pub mod http;
pub mod middleware;
pub mod sse;
pub(crate) mod stream;
pub mod subscriber;
pub mod verify;

pub use agent::{Agent, RunAgentParams};
pub use http::HttpAgent;
pub use middleware::{EventStreamExt, StreamTransformer, TransformerChain};
pub use verify::EventVerifier;

pub use ag_ui_core as core;
