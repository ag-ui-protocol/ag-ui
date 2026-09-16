//! JSON Patch operations, as defined by [RFC 6902].
//!
//! `STATE_DELTA` and `ACTIVITY_DELTA` carry a patch document: an array of these
//! operations, applied in order to the previous snapshot.
//!
//! [RFC 6902]: https://datatracker.ietf.org/doc/html/rfc6902

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A JSON Patch document: an ordered list of operations.
pub type JsonPatch = Vec<PatchOperation>;

/// A single [RFC 6902] operation.
///
/// The serde representation is the RFC wire format exactly: an object with an
/// `op` discriminator, a `path` JSON Pointer, and — depending on the operation
/// — a `value` or a `from` pointer.
///
/// # Why `value` has a default
///
/// Upstream types both patch fields as `z.array(z.any())` / `List[Any]` and
/// validates nothing, so a producer that drops `value` still parses there. The
/// case is not hypothetical: `JSON.stringify({op: "add", path: "/x", value:
/// undefined})` yields `{"op":"add","path":"/x"}`, which is what a JavaScript
/// producer emits whenever the new state holds `undefined` at that key. Making
/// `value` required would turn that into a deserialization failure for the whole
/// `STATE_DELTA` event — and in an SSE stream a failed event is usually a failed
/// run. An omitted `value` therefore reads as JSON `null`, which is how the
/// JavaScript patch libraries apply it, and re-serializes explicitly as `null`.
///
/// Everything else about the operation stays strictly typed: an unrecognized
/// `op` is still rejected, because the six RFC operations are the whole
/// vocabulary and a seventh is a producer bug worth surfacing rather than
/// carrying silently to an applier that cannot execute it.
///
/// ```
/// # use ag_ui::PatchOperation;
/// let op = PatchOperation::Replace {
///     path: "/counter".into(),
///     value: serde_json::json!(2),
/// };
/// assert_eq!(
///     serde_json::to_string(&op).unwrap(),
///     r#"{"op":"replace","path":"/counter","value":2}"#
/// );
/// ```
///
/// [RFC 6902]: https://datatracker.ietf.org/doc/html/rfc6902
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum PatchOperation {
    /// Inserts `value` at `path`, shifting array elements right when `path`
    /// ends in an array index or `-`.
    Add {
        /// JSON Pointer to the location to add.
        path: String,
        /// The value to insert. An omitted `value` reads as `null`; see the
        /// type-level docs.
        #[serde(default)]
        value: Value,
    },

    /// Removes the value at `path`.
    Remove {
        /// JSON Pointer to the location to remove.
        path: String,
    },

    /// Replaces the value at `path`, which must already exist.
    Replace {
        /// JSON Pointer to the location to overwrite.
        path: String,
        /// The replacement value. An omitted `value` reads as `null`.
        #[serde(default)]
        value: Value,
    },

    /// Moves the value at `from` to `path`.
    Move {
        /// JSON Pointer to the source location.
        from: String,
        /// JSON Pointer to the destination.
        path: String,
    },

    /// Copies the value at `from` to `path`.
    Copy {
        /// JSON Pointer to the source location.
        from: String,
        /// JSON Pointer to the destination.
        path: String,
    },

    /// Asserts that the value at `path` equals `value`; a failed test aborts
    /// the whole patch.
    Test {
        /// JSON Pointer to the location to test.
        path: String,
        /// The value the location is expected to hold. An omitted `value` reads
        /// as `null`.
        #[serde(default)]
        value: Value,
    },
}

impl PatchOperation {
    /// Builds an [`Add`](PatchOperation::Add) operation.
    pub fn add(path: impl Into<String>, value: impl Into<Value>) -> Self {
        Self::Add {
            path: path.into(),
            value: value.into(),
        }
    }

    /// Builds a [`Remove`](PatchOperation::Remove) operation.
    pub fn remove(path: impl Into<String>) -> Self {
        Self::Remove { path: path.into() }
    }

    /// Builds a [`Replace`](PatchOperation::Replace) operation.
    pub fn replace(path: impl Into<String>, value: impl Into<Value>) -> Self {
        Self::Replace {
            path: path.into(),
            value: value.into(),
        }
    }

    /// Builds a [`Move`](PatchOperation::Move) operation.
    pub fn mv(from: impl Into<String>, path: impl Into<String>) -> Self {
        Self::Move {
            from: from.into(),
            path: path.into(),
        }
    }

    /// Builds a [`Copy`](PatchOperation::Copy) operation.
    pub fn copy(from: impl Into<String>, path: impl Into<String>) -> Self {
        Self::Copy {
            from: from.into(),
            path: path.into(),
        }
    }

    /// Builds a [`Test`](PatchOperation::Test) operation.
    pub fn test(path: impl Into<String>, value: impl Into<Value>) -> Self {
        Self::Test {
            path: path.into(),
            value: value.into(),
        }
    }

    /// The `op` string as it appears on the wire.
    pub const fn op(&self) -> &'static str {
        match self {
            Self::Add { .. } => "add",
            Self::Remove { .. } => "remove",
            Self::Replace { .. } => "replace",
            Self::Move { .. } => "move",
            Self::Copy { .. } => "copy",
            Self::Test { .. } => "test",
        }
    }

    /// The JSON Pointer this operation targets.
    pub fn path(&self) -> &str {
        match self {
            Self::Add { path, .. }
            | Self::Remove { path }
            | Self::Replace { path, .. }
            | Self::Move { path, .. }
            | Self::Copy { path, .. }
            | Self::Test { path, .. } => path,
        }
    }

    /// The source pointer of a `move` or `copy`, or `None` for other operations.
    pub fn from(&self) -> Option<&str> {
        match self {
            Self::Move { from, .. } | Self::Copy { from, .. } => Some(from),
            _ => None,
        }
    }

    /// The payload of an `add`, `replace` or `test`, or `None` for other
    /// operations.
    pub const fn value(&self) -> Option<&Value> {
        match self {
            Self::Add { value, .. } | Self::Replace { value, .. } | Self::Test { value, .. } => {
                Some(value)
            }
            _ => None,
        }
    }
}
