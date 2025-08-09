use serde::{Deserialize, Serialize};
use std::ops::Deref;
use uuid::Uuid;

/// Macro to define a newtype ID based on Uuid.
macro_rules! define_id_type {
    // This arm of the macro handles calls that don't specify extra derives.
    ($name:ident) => {
        define_id_type!($name,);
    };
    // This arm handles calls that do specify extra derives (like Eq).
    ($name:ident, $($extra_derive:ident),*) => {
        #[doc = concat!(stringify!($name), ": A newtype used to prevent mixing it with other ID values.")]
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Eq, Hash, $($extra_derive),*)]
        pub struct $name(Uuid);

        impl $name {
            /// Creates a new random ID.
            pub fn random() -> Self {
                Self(Uuid::new_v4())
            }
        }

        /// Allows creating an ID from a Uuid.
        impl From<Uuid> for $name {
            fn from(uuid: Uuid) -> Self {
                Self(uuid)
            }
        }

        /// Allows converting an ID back into a Uuid.
        impl From<$name> for Uuid {
            fn from(id: $name) -> Self {
                id.0
            }
        }

        /// Allows getting a reference to the inner Uuid.
        impl AsRef<Uuid> for $name {
            fn as_ref(&self) -> &Uuid {
                &self.0
            }
        }

        /// Allows printing the ID.
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        /// Allows parsing an ID from a string slice.
        impl std::str::FromStr for $name {
            type Err = uuid::Error;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self(Uuid::parse_str(s)?))
            }
        }

        /// Allows comparing the ID with a Uuid.
        impl PartialEq<Uuid> for $name {
            fn eq(&self, other: &Uuid) -> bool {
                self.0 == *other
            }
        }

        /// Allows comparing the ID with a string slice.
        impl PartialEq<str> for $name {
            fn eq(&self, other: &str) -> bool {
                if let Ok(uuid) = Uuid::parse_str(other) {
                    self.0 == uuid
                } else {
                    false
                }
            }
        }
    };
}

define_id_type!(AgentId);
define_id_type!(ThreadId);
define_id_type!(RunId);
define_id_type!(MessageId);

#[derive(Debug, PartialEq, Eq, Deserialize, Serialize, Clone)]
pub struct ToolCallId(String);

/// Tool Call ID
///
/// Does not follow UUID format, instead uses "call_xxxxxxxx"
impl ToolCallId {
    pub fn random() -> Self {
        let uuid = &Uuid::new_v4().to_string()[..8];
        let id = format!("call_{uuid}");
        Self(id)
    }
}

impl Deref for ToolCallId {
    type Target = str;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    // Test whether tool call ID has same format as rest of AG-UI
    #[test]
    fn test_tool_call_random() {
        let id = super::ToolCallId::random();
        assert_eq!(id.0.len(), 5 + 8);
        assert!(id.0.starts_with("call_"));
        dbg!(id);
    }
}
