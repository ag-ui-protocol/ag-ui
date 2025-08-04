use uuid::Uuid;
use serde::{Deserialize, Serialize};

/// Macro to define a newtype ID based on Uuid.
/// Accepts doc comments and other derive-able attributes.
macro_rules! define_id_type {
    // This arm handles calls that do specify extra derives (like Eq).
    ($(#[$attr:meta])* $name:ident, $($extra_derive:ident),*) => {
        $(#[$attr])*
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Eq, Hash, $($extra_derive),*)]
        pub struct $name(Uuid);

        impl $name {
            /// Creates a new random ID.
            pub fn new() -> Self {
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
    ($(#[$attr:meta])* $name:ident) => {
        define_id_type!($(#[$attr])* $name,);
    };
}

define_id_type!(
    /// Agent ID
    ///
    /// A newtype is used to prevent mixing them with other ID values.
    AgentId
);

define_id_type!(
    /// Thread ID
    ///
    /// A newtype is used to prevent mixing them with other ID values.
    ThreadId
);

define_id_type!(
    /// Run ID
    ///
    /// A newtype is used to prevent mixing them with other ID values.
    RunId
);

define_id_type!(
    /// Tool Call ID
    ///
    /// A newtype is used to prevent mixing them with other ID values.
    ToolCallId
);

define_id_type!(
    /// Message ID
    ///
    /// A newtype is used to prevent mixing them with other ID values.
    MessageId
);