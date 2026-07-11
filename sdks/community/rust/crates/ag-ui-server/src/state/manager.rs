//! `StateManager` implementation with JSON Patch delta generation.

use crate::error::{StateError, StateResult};
use ag_ui_core::AgentState;
use json_patch::{diff, Patch, PatchOperation};
use parking_lot::RwLock;
use serde::Serialize;
use std::sync::Arc;

/// A JSON Patch representing state changes (RFC 6902).
///
/// This is a newtype wrapper around `json_patch::Patch` that provides
/// convenient serialization and inspection methods.
///
/// # Example
///
/// ```rust
/// use ag_ui_server::state::{StateManager, StatePatch};
/// use serde_json::json;
///
/// let manager = StateManager::new(json!({"x": 1}));
/// let patch = manager.update(|s| s["x"] = json!(2)).unwrap();
///
/// // Serialize the patch for transmission
/// let json = serde_json::to_string(&patch).unwrap();
/// assert!(json.contains("replace"));
/// ```
#[derive(Debug, Clone, Default)]
pub struct StatePatch(pub Patch);

impl StatePatch {
    /// Create an empty patch (no operations).
    #[must_use]
    pub fn empty() -> Self {
        Self(Patch(Vec::new()))
    }

    /// Check if this patch has no operations.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0 .0.is_empty()
    }

    /// Get the number of operations in this patch.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0 .0.len()
    }

    /// Get the operations in this patch.
    #[must_use]
    pub fn operations(&self) -> &[PatchOperation] {
        &self.0 .0
    }

    /// Convert to the underlying Patch type.
    #[must_use]
    pub fn into_inner(self) -> Patch {
        self.0
    }
}

impl Serialize for StatePatch {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl From<Patch> for StatePatch {
    fn from(patch: Patch) -> Self {
        Self(patch)
    }
}

impl From<StatePatch> for Patch {
    fn from(patch: StatePatch) -> Self {
        patch.0
    }
}

/// Thread-safe state manager with automatic JSON Patch delta generation.
///
/// `StateManager` wraps agent state and provides:
///
/// - Thread-safe read/write access via `parking_lot::RwLock`
/// - Automatic delta generation on updates using JSON Patch (RFC 6902)
/// - Snapshot retrieval for `STATE_SNAPSHOT` events
/// - Atomic compare-and-swap operations for conditional updates
///
/// # Thread Safety
///
/// The manager uses `parking_lot::RwLock` which provides:
/// - Multiple concurrent readers
/// - Exclusive writer access
/// - Fair scheduling to prevent writer starvation
/// - No poisoning (panics in critical sections don't corrupt state access)
///
/// # Example
///
/// ```rust
/// use ag_ui_server::state::StateManager;
/// use serde_json::json;
///
/// // Create with initial state
/// let manager = StateManager::new(json!({
///     "messages": [],
///     "context": {"user": "alice"}
/// }));
///
/// // Read without locking for writes
/// let user = manager.read(|s| {
///     s["context"]["user"].as_str().unwrap_or("unknown").to_string()
/// });
///
/// // Update and capture delta
/// let delta = manager.update(|state| {
///     state["messages"].as_array_mut()
///         .expect("messages should be an array")
///         .push(json!({"role": "assistant", "content": "Hello!"}));
/// }).expect("update should succeed");
///
/// // Delta can be serialized for STATE_DELTA event
/// println!("Changes: {}", serde_json::to_string(&delta).unwrap());
/// ```
#[derive(Debug)]
pub struct StateManager<S: AgentState = serde_json::Value> {
    state: Arc<RwLock<S>>,
}

impl<S: AgentState> Clone for StateManager<S> {
    fn clone(&self) -> Self {
        Self {
            state: Arc::clone(&self.state),
        }
    }
}

impl<S: AgentState> StateManager<S> {
    /// Create a new state manager with the given initial state.
    ///
    /// # Example
    ///
    /// ```rust
    /// use ag_ui_server::state::StateManager;
    /// use serde_json::json;
    ///
    /// let manager = StateManager::new(json!({"initialized": true}));
    /// ```
    pub fn new(initial: S) -> Self {
        Self {
            state: Arc::new(RwLock::new(initial)),
        }
    }

    /// Read the current state without modification.
    ///
    /// This acquires a read lock, allowing concurrent readers.
    ///
    /// # Example
    ///
    /// ```rust
    /// use ag_ui_server::state::StateManager;
    /// use serde_json::json;
    ///
    /// let manager = StateManager::new(json!({"count": 42}));
    /// let count = manager.read(|s| s["count"].as_i64().unwrap_or(0));
    /// assert_eq!(count, 42);
    /// ```
    pub fn read<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&S) -> R,
    {
        let guard = self.state.read();
        f(&guard)
    }

    /// Get a clone of the current state.
    ///
    /// Useful for creating `STATE_SNAPSHOT` events.
    ///
    /// # Example
    ///
    /// ```rust
    /// use ag_ui_server::state::StateManager;
    /// use serde_json::json;
    ///
    /// let manager = StateManager::new(json!({"x": 1}));
    /// let snapshot = manager.snapshot();
    /// assert_eq!(snapshot, json!({"x": 1}));
    /// ```
    #[must_use]
    pub fn snapshot(&self) -> S {
        self.state.read().clone()
    }

    /// Update state and return the JSON Patch delta.
    ///
    /// This acquires an exclusive write lock, serializes the state before
    /// and after the update, and computes the JSON Patch difference.
    ///
    /// # Errors
    ///
    /// Returns `StateError::Serialization` if the state cannot be serialized
    /// to JSON (required for diff computation).
    ///
    /// # Example
    ///
    /// ```rust
    /// use ag_ui_server::state::StateManager;
    /// use serde_json::json;
    ///
    /// let manager = StateManager::new(json!({"count": 0}));
    ///
    /// let patch = manager.update(|s| {
    ///     s["count"] = json!(1);
    /// }).expect("serialization should succeed");
    ///
    /// assert_eq!(patch.len(), 1);
    /// ```
    pub fn update<F>(&self, f: F) -> StateResult<StatePatch>
    where
        F: FnOnce(&mut S),
    {
        let mut guard = self.state.write();

        // Serialize state before update for diff
        let before = serde_json::to_value(&*guard).map_err(|e| StateError::Serialization {
            reason: format!("failed to serialize state before update: {e}"),
        })?;

        // Apply the update
        f(&mut guard);

        // Serialize state after update
        let after = serde_json::to_value(&*guard).map_err(|e| StateError::Serialization {
            reason: format!("failed to serialize state after update: {e}"),
        })?;

        // Compute diff
        let patch = diff(&before, &after);
        Ok(StatePatch(patch))
    }

    /// Replace the entire state and return the delta.
    ///
    /// This is equivalent to `update(|s| *s = new_state)` but more explicit.
    ///
    /// # Errors
    ///
    /// Returns `StateError::Serialization` if serialization fails.
    ///
    /// # Example
    ///
    /// ```rust
    /// use ag_ui_server::state::StateManager;
    /// use serde_json::json;
    ///
    /// let manager = StateManager::new(json!({"old": true}));
    /// let patch = manager.replace(json!({"new": true})).unwrap();
    ///
    /// assert!(manager.read(|s| s["new"].as_bool().unwrap_or(false)));
    /// ```
    pub fn replace(&self, new_state: S) -> StateResult<StatePatch> {
        self.update(|state| *state = new_state)
    }

    /// Conditionally update state if a predicate is satisfied.
    ///
    /// Returns `Ok(Some(patch))` if the update was applied,
    /// `Ok(None)` if the predicate returned false.
    ///
    /// # Errors
    ///
    /// Returns `StateError::Serialization` if serialization fails during update.
    ///
    /// # Example
    ///
    /// ```rust
    /// use ag_ui_server::state::StateManager;
    /// use serde_json::json;
    ///
    /// let manager = StateManager::new(json!({"count": 5}));
    ///
    /// // Only increment if count < 10
    /// let result = manager.update_if(
    ///     |s| s["count"].as_i64().unwrap_or(0) < 10,
    ///     |s| s["count"] = json!(s["count"].as_i64().unwrap_or(0) + 1),
    /// ).expect("update should succeed");
    ///
    /// assert!(result.is_some());
    /// assert_eq!(manager.read(|s| s["count"].as_i64().unwrap_or(0)), 6);
    /// ```
    pub fn update_if<P, F>(&self, predicate: P, f: F) -> StateResult<Option<StatePatch>>
    where
        P: FnOnce(&S) -> bool,
        F: FnOnce(&mut S),
    {
        let mut guard = self.state.write();

        if !predicate(&guard) {
            return Ok(None);
        }

        let before = serde_json::to_value(&*guard).map_err(|e| StateError::Serialization {
            reason: format!("failed to serialize state before conditional update: {e}"),
        })?;

        f(&mut guard);

        let after = serde_json::to_value(&*guard).map_err(|e| StateError::Serialization {
            reason: format!("failed to serialize state after conditional update: {e}"),
        })?;

        let patch = diff(&before, &after);
        Ok(Some(StatePatch(patch)))
    }

    /// Apply a JSON Patch to the current state.
    ///
    /// This is useful for applying patches received from other sources
    /// or for implementing undo/redo functionality.
    ///
    /// # Errors
    ///
    /// Returns `StateError::PatchFailed` if the patch cannot be applied,
    /// or `StateError::Serialization` if state serialization fails.
    ///
    /// # Example
    ///
    /// ```rust
    /// use ag_ui_server::state::StateManager;
    /// use json_patch::{Patch, PatchOperation, ReplaceOperation};
    /// use json_patch::jsonptr::PointerBuf;
    /// use serde_json::json;
    ///
    /// let manager = StateManager::new(json!({"x": 1}));
    ///
    /// let patch = Patch(vec![
    ///     PatchOperation::Replace(ReplaceOperation {
    ///         path: PointerBuf::parse("/x").expect("valid pointer"),
    ///         value: json!(2),
    ///     }),
    /// ]);
    ///
    /// manager.apply_patch(&patch).expect("patch should apply");
    /// assert_eq!(manager.read(|s| s["x"].as_i64().unwrap_or(0)), 2);
    /// ```
    pub fn apply_patch(&self, patch: &Patch) -> StateResult<()> {
        let mut guard = self.state.write();

        // Convert state to Value for patching
        let mut value = serde_json::to_value(&*guard).map_err(|e| StateError::Serialization {
            reason: format!("failed to serialize state for patching: {e}"),
        })?;

        // Apply the patch
        json_patch::patch(&mut value, patch).map_err(|e| StateError::PatchFailed {
            op: "apply".to_string(),
            path: "unknown".to_string(),
            reason: e.to_string(),
        })?;

        // Deserialize back to state type
        *guard = serde_json::from_value(value).map_err(|e| StateError::Serialization {
            reason: format!("failed to deserialize state after patching: {e}"),
        })?;

        Ok(())
    }

    /// Get strong reference count to the underlying state.
    ///
    /// Useful for debugging or determining if the state is shared.
    #[must_use]
    pub fn strong_count(&self) -> usize {
        Arc::strong_count(&self.state)
    }
}

impl<S: AgentState + Default> Default for StateManager<S> {
    fn default() -> Self {
        Self::new(S::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use json_patch::jsonptr::PointerBuf;
    use json_patch::{PatchOperation, ReplaceOperation};
    use serde_json::json;

    #[test]
    fn new_and_snapshot() {
        let manager = StateManager::new(json!({"key": "value"}));
        let snapshot = manager.snapshot();
        assert_eq!(snapshot, json!({"key": "value"}));
    }

    #[test]
    fn read_state() {
        let manager = StateManager::new(json!({"count": 42}));
        let count = manager.read(|s| s["count"].as_i64().unwrap_or(0));
        assert_eq!(count, 42);
    }

    #[test]
    fn update_generates_patch() {
        let manager = StateManager::new(json!({"count": 0}));

        let patch = manager
            .update(|s| {
                s["count"] = json!(1);
            })
            .expect("update should succeed");

        assert_eq!(patch.len(), 1);
        assert_eq!(manager.read(|s| s["count"].as_i64().unwrap_or(0)), 1);
    }

    #[test]
    fn update_add_field_generates_add_op() {
        let manager = StateManager::new(json!({}));

        let patch = manager
            .update(|s| {
                s["new_field"] = json!("new_value");
            })
            .expect("update should succeed");

        assert!(!patch.is_empty());

        // Verify the add operation
        let ops = patch.operations();
        assert!(
            ops.iter()
                .any(|op| matches!(op, PatchOperation::Add(_) | PatchOperation::Replace(_)))
        );
    }

    #[test]
    fn update_nested_value() {
        let manager = StateManager::new(json!({
            "user": {
                "name": "Alice",
                "age": 30
            }
        }));

        let patch = manager
            .update(|s| {
                s["user"]["age"] = json!(31);
            })
            .expect("update should succeed");

        assert!(!patch.is_empty());
        assert_eq!(
            manager.read(|s| s["user"]["age"].as_i64().unwrap_or(0)),
            31
        );
    }

    #[test]
    fn update_array() {
        let manager = StateManager::new(json!({"items": []}));

        let patch = manager
            .update(|s| {
                s["items"]
                    .as_array_mut()
                    .expect("items should be an array")
                    .push(json!("item1"));
            })
            .expect("update should succeed");

        assert!(!patch.is_empty());

        let items = manager.read(|s| s["items"].as_array().unwrap().len());
        assert_eq!(items, 1);
    }

    #[test]
    fn replace_state() {
        let manager = StateManager::new(json!({"old": true}));

        let patch = manager
            .replace(json!({"new": true}))
            .expect("replace should succeed");

        assert!(!patch.is_empty());
        assert!(manager.read(|s| s["new"].as_bool().unwrap_or(false)));
        assert!(manager.read(|s| s.get("old").is_none()));
    }

    #[test]
    fn update_if_predicate_true() {
        let manager = StateManager::new(json!({"count": 5}));

        let result = manager
            .update_if(
                |s| s["count"].as_i64().unwrap_or(0) < 10,
                |s| s["count"] = json!(6),
            )
            .expect("update should succeed");

        assert!(result.is_some());
        assert_eq!(manager.read(|s| s["count"].as_i64().unwrap_or(0)), 6);
    }

    #[test]
    fn update_if_predicate_false() {
        let manager = StateManager::new(json!({"count": 15}));

        let result = manager
            .update_if(
                |s| s["count"].as_i64().unwrap_or(0) < 10,
                |s| s["count"] = json!(16),
            )
            .expect("update should succeed");

        assert!(result.is_none());
        assert_eq!(manager.read(|s| s["count"].as_i64().unwrap_or(0)), 15);
    }

    #[test]
    fn apply_patch_success() {
        let manager = StateManager::new(json!({"x": 1}));

        let patch = Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: PointerBuf::parse("/x").expect("valid pointer"),
            value: json!(2),
        })]);

        manager.apply_patch(&patch).expect("patch should apply");
        assert_eq!(manager.read(|s| s["x"].as_i64().unwrap_or(0)), 2);
    }

    #[test]
    fn apply_patch_add_field() {
        let manager = StateManager::new(json!({}));

        let patch = Patch(vec![PatchOperation::Add(json_patch::AddOperation {
            path: PointerBuf::parse("/new").expect("valid pointer"),
            value: json!("value"),
        })]);

        manager.apply_patch(&patch).expect("patch should apply");
        assert_eq!(
            manager.read(|s| s["new"].as_str().unwrap_or("").to_string()),
            "value"
        );
    }

    #[test]
    fn empty_update_empty_patch() {
        let manager = StateManager::new(json!({"x": 1}));

        let patch = manager
            .update(|_s| {
                // No changes
            })
            .expect("update should succeed");

        assert!(patch.is_empty());
    }

    #[test]
    fn clone_shares_state() {
        let manager1 = StateManager::new(json!({"x": 1}));
        let manager2 = manager1.clone();

        manager1
            .update(|s| s["x"] = json!(2))
            .expect("update should succeed");

        assert_eq!(manager2.read(|s| s["x"].as_i64().unwrap_or(0)), 2);
    }

    #[test]
    fn strong_count() {
        let manager1 = StateManager::new(json!({}));
        assert_eq!(manager1.strong_count(), 1);

        let manager2 = manager1.clone();
        assert_eq!(manager1.strong_count(), 2);
        assert_eq!(manager2.strong_count(), 2);

        drop(manager2);
        assert_eq!(manager1.strong_count(), 1);
    }

    #[test]
    fn state_patch_serialize() {
        let manager = StateManager::new(json!({"x": 1}));
        let patch = manager
            .update(|s| s["x"] = json!(2))
            .expect("update should succeed");

        let json = serde_json::to_string(&patch).expect("serialization should succeed");
        assert!(json.contains("replace") || json.contains("add"));
        assert!(json.contains("/x"));
    }

    #[test]
    fn default_state_manager() {
        let manager: StateManager<serde_json::Value> = StateManager::default();
        let snapshot = manager.snapshot();
        assert_eq!(snapshot, serde_json::Value::Null);
    }
}
