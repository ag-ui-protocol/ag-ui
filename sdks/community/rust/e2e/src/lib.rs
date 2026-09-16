//! Deterministic HTTP/SSE integration and migration documentation checks.
#![forbid(unsafe_code)]

#[cfg(doctest)]
#[doc = include_str!("../../README.md")]
mod readme {}

#[cfg(doctest)]
#[doc = include_str!("../../MIGRATION.md")]
mod migration {}
