//! Web framework integrations for serving AG-UI agents.
//!
//! This module provides ready-to-use integrations with popular Rust web
//! frameworks, handling HTTP request/response formatting, SSE streaming,
//! and content negotiation.
//!
//! # Available Integrations
//!
//! - `axum` (requires `axum-integration` feature) - Integration with the Axum framework

#[cfg(feature = "axum-integration")]
pub mod axum;
