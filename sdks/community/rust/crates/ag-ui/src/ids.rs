//! String-backed identifier newtypes.
//!
//! # Why these wrap `String` and not `Uuid`
//!
//! AG-UI identifiers are *opaque strings*. Nothing in the protocol requires a
//! UUID, and real producers routinely send values that are not one: LangGraph
//! emits thread ids like `"thread-abc"` and run ids that are plain integers,
//! and several adapters reuse provider-side ids verbatim.
//!
//! An earlier community Rust SDK typed these fields as `Uuid`, which made every
//! LangGraph payload fail to deserialize (ag-ui-protocol/ag-ui#2195, #2196).
//! These newtypes therefore accept any string, including the empty one, and
//! round-trip it byte-for-byte. Callers that *want* UUIDs can generate one and
//! pass its string form.

use std::borrow::Cow;
use std::convert::Infallible;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        ///
        /// An opaque string. Any value round-trips losslessly, including
        /// non-UUID and empty strings — see the [module docs](self).
        #[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        #[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
        #[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
        pub struct $name(String);

        impl $name {
            /// Wraps any string-like value without validating it.
            #[inline]
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            /// Borrows the identifier as a string slice.
            #[inline]
            pub fn as_str(&self) -> &str {
                &self.0
            }

            /// Consumes the identifier and returns the wrapped [`String`].
            #[inline]
            pub fn into_inner(self) -> String {
                self.0
            }

            /// Returns `true` when the identifier is the empty string.
            #[inline]
            pub fn is_empty(&self) -> bool {
                self.0.is_empty()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<String> for $name {
            #[inline]
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            #[inline]
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl From<Cow<'_, str>> for $name {
            #[inline]
            fn from(value: Cow<'_, str>) -> Self {
                Self(value.into_owned())
            }
        }

        impl From<$name> for String {
            #[inline]
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl AsRef<str> for $name {
            #[inline]
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl std::ops::Deref for $name {
            type Target = str;

            #[inline]
            fn deref(&self) -> &str {
                &self.0
            }
        }

        impl FromStr for $name {
            type Err = Infallible;

            #[inline]
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self(s.to_owned()))
            }
        }

        impl PartialEq<str> for $name {
            #[inline]
            fn eq(&self, other: &str) -> bool {
                self.0 == other
            }
        }

        impl PartialEq<&str> for $name {
            #[inline]
            fn eq(&self, other: &&str) -> bool {
                self.0 == *other
            }
        }

        impl PartialEq<$name> for str {
            #[inline]
            fn eq(&self, other: &$name) -> bool {
                self == other.0
            }
        }
    };
}

string_id! {
    /// Identifies a conversation thread across runs.
    ThreadId
}

string_id! {
    /// Identifies a single agent run within a thread.
    RunId
}

string_id! {
    /// Identifies a message within a thread.
    MessageId
}

string_id! {
    /// Identifies one tool invocation.
    ToolCallId
}

string_id! {
    /// Identifies an agent, for multi-agent routing and discovery UIs.
    AgentId
}

string_id! {
    /// Names a step inside a run, as carried by `STEP_STARTED` / `STEP_FINISHED`.
    StepName
}

string_id! {
    /// Identifies **one invocation** of a subagent.
    ///
    /// Running the same subagent twice yields two different values. It is not a
    /// name and not a stable id for a reusable definition — that is
    /// `SUBAGENT_STARTED.name` — so key transient UI state by it and persist
    /// nothing by it. See [`crate::event::subagent`].
    SubagentRunId
}
