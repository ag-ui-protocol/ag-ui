//! Deserialization helpers shared by the protocol types.
//!
//! The protocol has two spellings of "no value" for an optional field, and
//! this crate has to know which one each field uses. Older fields —
//! `TOOL_CALL_START.parentMessageId`, `RUN_FINISHED.outcome` — tolerate an
//! explicit `null`, because producers shipped before every official SDK
//! learned to omit valueless fields, and rejecting what they already send
//! would break agents in the wild. Fields added after that fix have no such
//! history: `metadata`, `subagentRunId`, and `SUBAGENT_FINISHED.outcome` were
//! declared with "absent is the only spelling", so a `null` there is a
//! contract violation rather than an absence, and reading it as absent would
//! quietly grandfather in a fourth exception with nobody to protect.

use serde::{Deserialize, Deserializer};

/// Reads an optional field that may be absent but never `null`.
///
/// Pair it with `#[serde(default)]`: a missing key takes the default, `None`;
/// a present key must parse as `T`, so a JSON `null` fails with `T`'s own
/// type error instead of collapsing to `None`. The distinction is the one
/// [the module docs](self) describe — which fields tolerate `null` is part
/// of the wire contract, not a convenience.
pub(crate) fn reject_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
