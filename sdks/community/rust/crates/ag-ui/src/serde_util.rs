//! Deserialization helpers shared by the protocol types.
//!
//! AG-UI 1.0 represents an absent optional value by omitting its field.
//! A present `null` is invalid where the schema says `not: { type: null }`.
//! The shared client boundary enforces this on wire input; these helpers keep
//! the Rust models and their serialization consistent with the same rule.

use std::fmt;
use std::marker::PhantomData;

use serde::de::Visitor;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// Omits an optional JSON payload when its value is absent or explicitly null.
/// The AG-UI 1.0 wire form uses absence for either case.
pub(crate) fn is_none_or_null(value: &Option<Value>) -> bool {
    value.as_ref().is_none_or(Value::is_null)
}

/// Reads an optional non-null JSON payload represented as `Value::Null` when
/// the field is absent. A present null remains a protocol error.
pub(crate) fn reject_null_value<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Error as _;
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(D::Error::custom("present null is not allowed"));
    }
    Ok(value)
}

/// Reads an optional field that may be absent but never `null`.
///
/// Pair it with `#[serde(default)]`: a missing key takes the default, `None`;
/// a present key must parse as `T`. The visitor rejects a present `null` even
/// when `T` is `serde_json::Value`, which itself accepts null.
pub(crate) fn reject_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct NonNull<T>(PhantomData<T>);

    impl<'de, T: Deserialize<'de>> Visitor<'de> for NonNull<T> {
        type Value = Option<T>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("a present non-null value")
        }

        fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Err(E::custom("present null is not allowed"))
        }

        fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Err(E::custom("present null is not allowed"))
        }

        fn visit_some<D: Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            T::deserialize(deserializer).map(Some)
        }
    }

    deserializer.deserialize_option(NonNull(PhantomData))
}
