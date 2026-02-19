use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::hash::{Hash, Hasher};
use std::ops::Deref;
use uuid::Uuid;

/// Namespace UUID for generating deterministic UUIDs from arbitrary strings.
/// Using OID namespace as it's appropriate for identifiers.
const ID_NAMESPACE: Uuid = Uuid::NAMESPACE_OID;

/// Macro to define a newtype ID based on Uuid with round-trip preservation.
///
/// These ID types support the AG-UI protocol which uses string identifiers.
/// While the official TypeScript SDK uses plain strings, this Rust SDK provides
/// UUID-based types for type safety. When a non-UUID string is received (e.g.,
/// LangGraph's `lc_run--...` format), we:
///
/// 1. Generate a deterministic UUID using UUID v5 (namespace + original string)
/// 2. Preserve the original string for serialization (round-trip fidelity)
///
/// This allows internal code to work with UUIDs while maintaining protocol
/// compatibility with servers that use arbitrary string IDs.
macro_rules! define_id_type {
    // This arm of the macro handles calls that don't specify extra derives.
    ($name:ident) => {
        define_id_type!($name,);
    };
    // This arm handles calls that do specify extra derives (like Eq).
    ($name:ident, $($extra_derive:ident),*) => {
        #[doc = concat!(stringify!($name), ": A newtype wrapper providing type-safe identifiers.")]
        ///
        /// Supports both UUID strings and arbitrary string IDs (like LangGraph's
        /// `lc_run--...` format). Non-UUID strings are hashed to UUIDs internally
        /// but preserved for round-trip serialization.
        #[derive(Debug, Clone, $($extra_derive),*)]
        pub struct $name {
            /// Internal UUID representation (always available)
            uuid: Uuid,
            /// Original string if it wasn't a valid UUID (for round-trip serialization)
            raw: Option<String>,
        }

        impl $name {
            /// Creates a new random ID.
            pub fn random() -> Self {
                Self {
                    uuid: Uuid::new_v4(),
                    raw: None,
                }
            }

            /// Creates a new ID from a string.
            ///
            /// If the string is a valid UUID, it's used directly.
            /// Otherwise, a deterministic UUID is generated via UUID v5,
            /// and the original string is preserved for serialization.
            pub fn new(s: impl AsRef<str>) -> Self {
                let s = s.as_ref();
                match Uuid::parse_str(s) {
                    Ok(uuid) => Self { uuid, raw: None },
                    Err(_) => Self {
                        uuid: Uuid::new_v5(&ID_NAMESPACE, s.as_bytes()),
                        raw: Some(s.to_owned()),
                    },
                }
            }

            /// Returns the internal UUID representation.
            ///
            /// This is always available, even for non-UUID string IDs
            /// (in which case it's a deterministic hash of the original).
            pub fn as_uuid(&self) -> &Uuid {
                &self.uuid
            }

            /// Returns `true` if this ID was created from a non-UUID string.
            ///
            /// Useful for logging/debugging to identify IDs that were coerced
            /// from arbitrary strings (e.g., LangGraph format).
            pub fn was_coerced(&self) -> bool {
                self.raw.is_some()
            }

            /// Returns the original string if this ID was coerced, or `None` if
            /// it was created from a valid UUID.
            pub fn original_string(&self) -> Option<&str> {
                self.raw.as_deref()
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let s = String::deserialize(deserializer)?;
                Ok(Self::new(&s))
            }
        }

        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                // Round-trip preservation: serialize original string if we had one
                match &self.raw {
                    Some(original) => serializer.serialize_str(original),
                    None => serializer.serialize_str(&self.uuid.to_string()),
                }
            }
        }

        // Manual PartialEq: equality is based solely on the UUID
        // Two IDs are equal if they resolve to the same internal UUID,
        // regardless of whether they came from different original strings
        // (though in practice, same original -> same UUID via deterministic hash)
        impl PartialEq for $name {
            fn eq(&self, other: &Self) -> bool {
                self.uuid == other.uuid
            }
        }

        impl Eq for $name {}

        // Manual Hash: hash only the UUID for consistency with PartialEq
        impl Hash for $name {
            fn hash<H: Hasher>(&self, state: &mut H) {
                self.uuid.hash(state);
            }
        }

        /// Allows creating an ID from a Uuid.
        impl From<Uuid> for $name {
            fn from(uuid: Uuid) -> Self {
                Self { uuid, raw: None }
            }
        }

        /// Allows converting an ID back into a Uuid.
        impl From<$name> for Uuid {
            fn from(id: $name) -> Self {
                id.uuid
            }
        }

        /// Allows getting a reference to the inner Uuid.
        impl AsRef<Uuid> for $name {
            fn as_ref(&self) -> &Uuid {
                &self.uuid
            }
        }

        /// Allows printing the ID.
        /// Returns the original string if coerced, otherwise the UUID string.
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                match &self.raw {
                    Some(original) => write!(f, "{}", original),
                    None => write!(f, "{}", self.uuid),
                }
            }
        }

        /// Allows parsing an ID from a string slice.
        ///
        /// Note: This now accepts any string (not just valid UUIDs),
        /// matching the behavior of `new()` and `Deserialize`.
        impl std::str::FromStr for $name {
            type Err = std::convert::Infallible;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self::new(s))
            }
        }

        /// Allows comparing the ID with a Uuid.
        impl PartialEq<Uuid> for $name {
            fn eq(&self, other: &Uuid) -> bool {
                self.uuid == *other
            }
        }

        /// Allows comparing the ID with a string slice.
        impl PartialEq<str> for $name {
            fn eq(&self, other: &str) -> bool {
                // First check if we have an original string that matches
                if let Some(ref raw) = self.raw {
                    if raw == other {
                        return true;
                    }
                }
                // Then try to parse as UUID and compare
                if let Ok(uuid) = Uuid::parse_str(other) {
                    self.uuid == uuid
                } else {
                    // Compare by computing what the UUID would be
                    self.uuid == Uuid::new_v5(&ID_NAMESPACE, other.as_bytes())
                }
            }
        }
    };
}

define_id_type!(AgentId);
define_id_type!(ThreadId);
define_id_type!(RunId);
define_id_type!(MessageId);

/// A tool call ID.
/// Used by some providers to denote a specific ID for a tool call generation,
/// where the result of the tool call must also use this ID.
///
/// Unlike other ID types, ToolCallId uses plain strings without UUID conversion,
/// as tool call IDs follow provider-specific formats (e.g., OpenAI's `call_xxx`).
#[derive(Debug, PartialEq, Eq, Deserialize, Serialize, Clone, Hash)]
pub struct ToolCallId(String);

/// Tool Call ID
///
/// Does not follow UUID format, instead uses provider-specific formats
/// like "call_xxxxxxxx" for OpenAI.
impl ToolCallId {
    pub fn random() -> Self {
        let uuid = &Uuid::new_v4().to_string()[..8];
        let id = format!("call_{uuid}");
        Self(id)
    }

    /// Creates a new ToolCallId from a string.
    ///
    /// The string is used directly as the ID value.
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
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
    use super::*;

    // Test whether tool call ID has same format as rest of AG-UI
    #[test]
    fn test_tool_call_random() {
        let id = super::ToolCallId::random();
        assert_eq!(id.0.len(), 5 + 8);
        assert!(id.0.starts_with("call_"));
        dbg!(id);
    }

    #[test]
    fn test_message_id_deserialize_valid_uuid() {
        let uuid_str = "\"550e8400-e29b-41d4-a716-446655440000\"";
        let id: MessageId = serde_json::from_str(uuid_str).unwrap();
        assert_eq!(id.to_string(), "550e8400-e29b-41d4-a716-446655440000");
        assert!(!id.was_coerced());
    }

    #[test]
    fn test_message_id_deserialize_langgraph_format() {
        // LangGraph uses "lc_run--<uuid>" format which is NOT a valid UUID
        let langgraph_id = "\"lc_run--019bcffd-726e-7ca1-9708-98f26a168272\"";
        let id: MessageId = serde_json::from_str(langgraph_id).unwrap();

        // Should not panic, and should produce a deterministic UUID
        assert!(!id.to_string().is_empty());
        assert!(id.was_coerced());

        // Verify it's deterministic (same input = same output)
        let id2: MessageId = serde_json::from_str(langgraph_id).unwrap();
        assert_eq!(id, id2);
    }

    #[test]
    fn test_run_id_deserialize_non_uuid_string() {
        let arbitrary_id = "\"my-custom-run-id-123\"";
        let id: RunId = serde_json::from_str(arbitrary_id).unwrap();
        assert!(!id.to_string().is_empty());
        assert!(id.was_coerced());

        // Verify determinism
        let id2: RunId = serde_json::from_str(arbitrary_id).unwrap();
        assert_eq!(id, id2);
    }

    #[test]
    fn test_new_and_deserialize_produce_same_result() {
        // The new() method and deserialize should produce the same UUID for the same input
        let langgraph_id = "lc_run--019bcffd-726e-7ca1-9708-98f26a168272";
        let from_new = MessageId::new(langgraph_id);
        let from_deser: MessageId =
            serde_json::from_str(&format!("\"{}\"", langgraph_id)).unwrap();
        assert_eq!(from_new, from_deser);
    }

    #[test]
    fn test_serialize_roundtrip_valid_uuid() {
        let original = MessageId::random();
        let serialized = serde_json::to_string(&original).unwrap();
        let deserialized: MessageId = serde_json::from_str(&serialized).unwrap();
        assert_eq!(original, deserialized);
        assert!(!deserialized.was_coerced());
    }

    // New tests for round-trip fidelity with non-UUID strings

    #[test]
    fn test_serialize_roundtrip_langgraph_format() {
        // This is the key test: non-UUID strings should round-trip perfectly
        let langgraph_id = "lc_run--019bcffd-726e-7ca1-9708-98f26a168272";
        let id = MessageId::new(langgraph_id);

        // Serialize should produce the original string, not a UUID
        let serialized = serde_json::to_string(&id).unwrap();
        assert_eq!(serialized, format!("\"{}\"", langgraph_id));

        // Deserialize should produce an equal ID
        let deserialized: MessageId = serde_json::from_str(&serialized).unwrap();
        assert_eq!(id, deserialized);
        assert!(deserialized.was_coerced());
        assert_eq!(deserialized.original_string(), Some(langgraph_id));
    }

    #[test]
    fn test_serialize_roundtrip_arbitrary_string() {
        let arbitrary_id = "my-custom-run-id-123";
        let id = RunId::new(arbitrary_id);

        let serialized = serde_json::to_string(&id).unwrap();
        assert_eq!(serialized, format!("\"{}\"", arbitrary_id));

        let deserialized: RunId = serde_json::from_str(&serialized).unwrap();
        assert_eq!(id, deserialized);
    }

    #[test]
    fn test_display_preserves_original() {
        let langgraph_id = "lc_run--019bcffd-726e-7ca1-9708-98f26a168272";
        let id = MessageId::new(langgraph_id);

        // Display should show the original string, not the hashed UUID
        assert_eq!(id.to_string(), langgraph_id);
    }

    #[test]
    fn test_display_shows_uuid_for_valid_uuid() {
        let uuid_str = "550e8400-e29b-41d4-a716-446655440000";
        let id = MessageId::new(uuid_str);

        // Display should show the UUID
        assert_eq!(id.to_string(), uuid_str);
        assert!(!id.was_coerced());
    }

    #[test]
    fn test_was_coerced_flag() {
        let uuid_id = MessageId::new("550e8400-e29b-41d4-a716-446655440000");
        assert!(!uuid_id.was_coerced());
        assert!(uuid_id.original_string().is_none());

        let coerced_id = MessageId::new("not-a-uuid");
        assert!(coerced_id.was_coerced());
        assert_eq!(coerced_id.original_string(), Some("not-a-uuid"));
    }

    #[test]
    fn test_as_uuid_always_available() {
        let uuid_str = "550e8400-e29b-41d4-a716-446655440000";
        let uuid_id = MessageId::new(uuid_str);
        assert_eq!(uuid_id.as_uuid(), &Uuid::parse_str(uuid_str).unwrap());

        let coerced_id = MessageId::new("not-a-uuid");
        // as_uuid should return a valid UUID (the v5 hash)
        let uuid = coerced_id.as_uuid();
        assert!(!uuid.is_nil());
    }

    #[test]
    fn test_hash_consistency() {
        use std::collections::HashMap;

        let id1 = ThreadId::new("lc_run--abc");
        let id2 = ThreadId::new("lc_run--abc");

        let mut map = HashMap::new();
        map.insert(id1.clone(), "value1");

        // id2 should find the same entry as id1
        assert_eq!(map.get(&id2), Some(&"value1"));
    }

    #[test]
    fn test_equality_with_string() {
        let langgraph_id = "lc_run--019bcffd-726e-7ca1-9708-98f26a168272";
        let id = MessageId::new(langgraph_id);

        // Should be equal to the original string
        assert!(id == *langgraph_id);
    }

    #[test]
    fn test_from_uuid() {
        let uuid = Uuid::new_v4();
        let id: MessageId = uuid.into();

        assert!(!id.was_coerced());
        assert_eq!(id.as_uuid(), &uuid);
    }

    #[test]
    fn test_into_uuid() {
        let original_uuid = Uuid::new_v4();
        let id: MessageId = original_uuid.into();
        let recovered: Uuid = id.into();

        assert_eq!(original_uuid, recovered);
    }

    #[test]
    fn test_from_str_accepts_any_string() {
        // FromStr should now accept any string, not just UUIDs
        let id: MessageId = "not-a-uuid".parse().unwrap();
        assert!(id.was_coerced());

        let id2: MessageId = "550e8400-e29b-41d4-a716-446655440000".parse().unwrap();
        assert!(!id2.was_coerced());
    }

    #[test]
    fn test_uuid_v5_is_deterministic() {
        // Verify that UUID v5 produces the same result for the same input
        let input = "lc_run--019bcffd-726e-7ca1-9708-98f26a168272";

        let id1 = MessageId::new(input);
        let id2 = MessageId::new(input);

        // Both should have the same internal UUID
        assert_eq!(id1.as_uuid(), id2.as_uuid());

        // And that UUID should be deterministic
        let expected = Uuid::new_v5(&ID_NAMESPACE, input.as_bytes());
        assert_eq!(id1.as_uuid(), &expected);
    }
}
