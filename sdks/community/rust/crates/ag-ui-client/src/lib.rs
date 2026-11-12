#![doc = include_str!("../README.md")]

pub mod agent;
mod chunk;
pub mod error;
pub mod event_handler;
#[cfg(feature = "http")]
pub mod http;
mod protocol_state;
pub mod sse;
pub(crate) mod stream;
pub use stream::EventStream;
pub mod subscriber;
pub use agent::{Agent, RunAgentParams, RunAgentResult, RunTerminalStatus};
#[cfg(feature = "http")]
pub use http::HttpAgent;

pub use ag_ui_core as core;
