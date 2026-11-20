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

/// The most characters of input text one warning repeats.
pub(crate) const EXCERPT: usize = 64;

/// Input text as a warning repeats it: at most [`EXCERPT`] characters, with
/// control characters escaped, so the warning stays one bounded line however
/// large or strange the input. `segment` also escapes it as a JSON Pointer
/// reference token.
pub(crate) fn excerpt(text: &str, segment: bool) -> String {
    let mut excerpt = String::new();
    let mut chars = text.chars();
    for c in chars.by_ref().take(EXCERPT) {
        match c {
            '~' if segment => excerpt.push_str("~0"),
            '/' if segment => excerpt.push_str("~1"),
            c if c.is_control() => excerpt.extend(c.escape_default()),
            c => excerpt.push(c),
        }
    }
    if chars.next().is_some() {
        excerpt.push('…');
    }
    excerpt
}

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

/// AG-UI 1.0 bounds timestamps and execution limits to the integers all
/// JSON peers can represent without rounding.
const MAX_SAFE_INTEGER: i128 = (1 << 53) - 1;

pub(crate) fn serialize_safe_integer<S, T>(
    value: &Option<T>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    T: Copy + Into<i128> + serde::Serialize,
    S: serde::Serializer,
{
    if value.is_some_and(|n| !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n.into())) {
        return Err(serde::ser::Error::custom(
            "integer outside the AG-UI 1.0 safe range",
        ));
    }
    serde::Serialize::serialize(value, serializer)
}

pub(crate) fn serialize_timestamp<S: serde::Serializer>(
    value: &Option<i64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serialize_safe_integer(value, serializer)
        .map_err(|error| serde::ser::Error::custom(format_args!("timestamp: {error}")))
}

/// Reads an optional non-negative integer, taking a negative one as absent.
///
/// For limits the schema bounds with `minimum: 0` while producers in the wild
/// send `-1` for "no limit". Absent already means not declared, and failing
/// the whole document over it would lose everything else in it.
///
/// The schema types these `integer`, which in JSON Schema is any number with
/// no fractional part: `10.0` and `1e1` are the integer ten, and a producer
/// whose language keeps its numbers as floats writes them that way. They are
/// read as the integer they are, as the wire boundary reads them.
pub(crate) fn non_negative<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Error as _;
    let Some(number) = Option::<serde_json::Number>::deserialize(deserializer)? else {
        return Ok(None);
    };
    if let Some(value) = number.as_u64() {
        return if i128::from(value) <= MAX_SAFE_INTEGER {
            Ok(Some(value))
        } else {
            Err(D::Error::custom("integer outside the AG-UI 1.0 safe range"))
        };
    }
    if number.is_i64() {
        return Ok(None);
    }
    match number.as_f64() {
        Some(value) if value.fract() == 0.0 && value < 0.0 => Ok(None),
        // Every integer in the safe range converts exactly.
        Some(value) if value.fract() == 0.0 && value <= MAX_SAFE_INTEGER as f64 => {
            Ok(Some(value as u64))
        }
        _ => Err(D::Error::custom(format!(
            "expected an integer, found {number}"
        ))),
    }
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
