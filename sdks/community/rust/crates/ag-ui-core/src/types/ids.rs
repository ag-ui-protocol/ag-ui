use serde::{Deserialize, Serialize};
use std::{fmt, ops::Deref, str::FromStr};
use uuid::Uuid;

macro_rules! define_id_type {
    ($name:ident) => {
        #[doc = concat!(stringify!($name), " is an opaque protocol identifier.")]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn random() -> Self {
                Self(Uuid::new_v4().to_string())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }
        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }
        impl From<Uuid> for $name {
            fn from(value: Uuid) -> Self {
                Self(value.to_string())
            }
        }
        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
        impl Deref for $name {
            type Target = str;
            fn deref(&self) -> &str {
                &self.0
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }
        impl FromStr for $name {
            type Err = std::convert::Infallible;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self::from(s))
            }
        }
        impl PartialEq<str> for $name {
            fn eq(&self, other: &str) -> bool {
                self.0 == other
            }
        }
    };
}

define_id_type!(AgentId);
define_id_type!(ThreadId);
define_id_type!(RunId);
define_id_type!(MessageId);
define_id_type!(ToolCallId);

impl ToolCallId {
    pub fn random_call() -> Self {
        Self(format!("call_{}", &Uuid::new_v4().to_string()[..8]))
    }
}
