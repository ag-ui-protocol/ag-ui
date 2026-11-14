//! Bounded JSON Patch application for disposable reducer working copies.

use json_patch::PatchOperation;
use serde_json::Value;

/// Failure while applying a bounded patch to a disposable working copy.
/// The caller must discard that copy after any error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum PatchError {
    #[error("patch document exceeds maximum JSON depth")]
    DocumentTooDeep,
    #[error("patch operation would exceed maximum JSON depth")]
    OperationTooDeep,
    #[error("patch failed")]
    InvalidOperation,
}

/// Maximum number of edges from the document root to any JSON value.
pub const MAX_PATCH_DEPTH: usize = 128;

// Iterative so checking an untrusted value does not itself recurse.
fn depth(value: &Value) -> Result<usize, PatchError> {
    let mut pending = vec![(value, 0)];
    let mut maximum = 0;
    while let Some((value, level)) = pending.pop() {
        if level > MAX_PATCH_DEPTH {
            return Err(PatchError::DocumentTooDeep);
        }
        maximum = maximum.max(level);
        match value {
            Value::Array(values) => pending.extend(values.iter().map(|v| (v, level + 1))),
            Value::Object(values) => pending.extend(values.values().map(|v| (v, level + 1))),
            _ => {}
        }
    }
    Ok(maximum)
}

/// Apply a patch to a disposable working copy, bounding depth before every
/// operation. The caller must discard the copy on error and commit only on
/// success: this function deliberately does not roll back partial mutations.
///
/// `json_patch::patch` attempts rollback after errors, which can panic when a
/// failed move already removed its source. `patch_unsafe` avoids that rollback;
/// it does not involve Rust unsafe code. Predicting depth before insertion also
/// prevents a sequence of shallow moves/copies from building a recursively
/// undroppable value, even when every individual wire operation is shallow.
pub fn apply_patch_to_copy(
    document: &mut Value,
    operations: &[PatchOperation],
) -> Result<(), PatchError> {
    depth(document)?;
    for operation in operations {
        let insertion = match operation {
            PatchOperation::Add(op) => Some((op.path.as_str(), &op.value)),
            PatchOperation::Replace(op) => Some((op.path.as_str(), &op.value)),
            PatchOperation::Copy(op) => document
                .pointer(op.from.as_str())
                .map(|value| (op.path.as_str(), value)),
            PatchOperation::Move(op) => document
                .pointer(op.from.as_str())
                .map(|value| (op.path.as_str(), value)),
            PatchOperation::Test(op) => {
                depth(&op.value)?;
                None
            }
            PatchOperation::Remove(_) => None,
        };
        if let Some((path, value)) = insertion {
            // JSON Pointer escapes encode slashes as ~1, so literal slashes
            // count path segments, including empty property names.
            let destination_depth = path.bytes().filter(|byte| *byte == b'/').count();
            if destination_depth.saturating_add(depth(value)?) > MAX_PATCH_DEPTH {
                return Err(PatchError::OperationTooDeep);
            }
        }
        json_patch::patch_unsafe(document, std::slice::from_ref(operation))
            .map_err(|_| PatchError::InvalidOperation)?;
    }
    Ok(())
}
