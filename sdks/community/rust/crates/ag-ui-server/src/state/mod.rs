//! Thread-safe state management with JSON Patch (RFC 6902) support.
//!
//! This module provides [`StateManager`], a thread-safe wrapper around agent
//! state that automatically generates JSON Patch deltas for efficient streaming.
//!
//! # Architecture
//!
//! The state manager uses `parking_lot::RwLock` for efficient read-heavy access
//! patterns typical in agent applications. State updates atomically capture the
//! delta as a JSON Patch, allowing clients to efficiently sync state changes.
//!
//! # Example
//!
//! ```rust
//! use ag_ui_server::state::StateManager;
//! use serde_json::json;
//!
//! let manager = StateManager::new(json!({"count": 0, "items": []}));
//!
//! // Read current state
//! let count = manager.read(|s| s["count"].as_i64().unwrap_or(0));
//! assert_eq!(count, 0);
//!
//! // Update state and get delta
//! let patch = manager.update(|s| {
//!     s["count"] = json!(1);
//!     s["items"].as_array_mut().unwrap().push(json!("item1"));
//! }).expect("update should succeed");
//!
//! // The patch contains RFC 6902 operations
//! assert!(!patch.0.is_empty());
//! ```

mod manager;

pub use manager::{StateManager, StatePatch};
