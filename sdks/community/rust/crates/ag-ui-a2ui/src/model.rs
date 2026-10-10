//! Lossless local A2UI data model. Undefined slots are never sent as JSON values.

use crate::message::DataModelUpdate;
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Maximum implicit new array slots allocated by one default update.
/// Use `DataModel::apply_with_array_growth_limit` to choose another bound.
pub const DEFAULT_ARRAY_GROWTH_LIMIT: usize = 65_536;

/// A local model node, including the value JSON cannot express.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum ModelValue {
    /// An absent root or a deleted array slot.
    Undefined,
    /// Explicit JSON null.
    Null,
    /// JSON boolean.
    Bool(bool),
    /// JSON number.
    Number(serde_json::Number),
    /// JSON string.
    String(String),
    /// Ordered slots; deleting one preserves the length.
    Array(Vec<ModelValue>),
    /// Object fields; deleting a field removes it.
    Object(BTreeMap<String, ModelValue>),
}

impl From<Value> for ModelValue {
    fn from(value: Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(v) => Self::Bool(v),
            Value::Number(v) => Self::Number(v),
            Value::String(v) => Self::String(v),
            Value::Array(v) => Self::Array(v.into_iter().map(Self::from).collect()),
            Value::Object(v) => {
                Self::Object(v.into_iter().map(|(k, v)| (k, Self::from(v))).collect())
            }
        }
    }
}

impl ModelValue {
    /// Exports exact JSON, failing rather than replacing undefined with null.
    pub fn to_json(&self) -> Result<Value> {
        self.export("")
    }
    fn export(&self, path: &str) -> Result<Value> {
        Ok(match self {
            Self::Undefined => return Err(Error::Undefined(path.into())),
            Self::Null => Value::Null,
            Self::Bool(v) => Value::Bool(*v),
            Self::Number(v) => Value::Number(v.clone()),
            Self::String(v) => Value::String(v.clone()),
            Self::Array(v) => Value::Array(
                v.iter()
                    .enumerate()
                    .map(|(i, v)| v.export(&format!("{path}/{i}")))
                    .collect::<Result<_>>()?,
            ),
            Self::Object(v) => Value::Object(
                v.iter()
                    .map(|(k, v)| {
                        Ok((
                            k.clone(),
                            v.export(&format!(
                                "{path}/{}",
                                k.replace('~', "~0").replace('/', "~1")
                            ))?,
                        ))
                    })
                    .collect::<Result<_>>()?,
            ),
        })
    }
}

/// A versioned, serializable local snapshot; never an A2UI wire payload.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DataModel {
    snapshot_version: u32,
    root: ModelValue,
}
impl<'de> Deserialize<'de> for DataModel {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Snapshot {
            snapshot_version: u32,
            root: ModelValue,
        }
        let value = Snapshot::deserialize(deserializer)?;
        if value.snapshot_version != 1 {
            return Err(serde::de::Error::custom(
                "unsupported A2UI data model snapshot version",
            ));
        }
        Ok(Self {
            snapshot_version: 1,
            root: value.root,
        })
    }
}
impl Default for DataModel {
    fn default() -> Self {
        Self::from(Value::Object(Default::default()))
    }
}
impl From<Value> for DataModel {
    fn from(value: Value) -> Self {
        Self {
            snapshot_version: 1,
            root: value.into(),
        }
    }
}
impl PartialEq<Value> for DataModel {
    fn eq(&self, other: &Value) -> bool {
        self.to_json().ok().as_ref() == Some(other)
    }
}
impl DataModel {
    /// The exact local root, including an undefined root after deletion.
    pub fn root(&self) -> &ModelValue {
        &self.root
    }
    /// Exact JSON export, rejecting undefined roots and slots.
    pub fn to_json(&self) -> Result<Value> {
        self.root.to_json()
    }
    /// Looks up an absolute JSON Pointer. Missing and undefined return `None`;
    /// explicit null returns `Some(ModelValue::Null)`.
    pub fn lookup(&self, path: &str) -> Result<Option<&ModelValue>> {
        let tokens = tokens(path)?;
        let mut node = &self.root;
        for token in tokens {
            node = match node {
                ModelValue::Object(map) => match map.get(&token) {
                    Some(v) => v,
                    None => return Ok(None),
                },
                ModelValue::Array(array) => match array.get(index(&token, path)?) {
                    Some(v) => v,
                    None => return Ok(None),
                },
                _ => return Ok(None),
            };
        }
        Ok((!matches!(node, ModelValue::Undefined)).then_some(node))
    }
    /// Applies an update atomically. Missing/null containers are created and
    /// numeric paths create arrays. Sparse gaps are undefined. Implicit array
    /// growth is bounded by [`DEFAULT_ARRAY_GROWTH_LIMIT`] per update.
    pub fn apply(&mut self, path: &str, value: &DataModelUpdate) -> Result<()> {
        self.apply_with_array_growth_limit(path, value, DEFAULT_ARRAY_GROWTH_LIMIT)
    }
    /// Applies with an explicit allocation budget for newly created array slots.
    /// The budget covers all nested expansions in this update. An invalid path
    /// or exhausted budget leaves the original model unchanged.
    pub fn apply_with_array_growth_limit(
        &mut self,
        path: &str,
        value: &DataModelUpdate,
        max_new_slots: usize,
    ) -> Result<()> {
        let tokens = tokens(path)?;
        let mut next = self.root.clone();
        let mut remaining = max_new_slots;
        if !tokens.is_empty() && matches!(next, ModelValue::Undefined | ModelValue::Null) {
            next = ModelValue::Object(BTreeMap::new());
        }
        apply(&mut next, &tokens, value, path, &mut remaining)?;
        self.root = next;
        Ok(())
    }
}

fn tokens(path: &str) -> Result<Vec<String>> {
    if path.is_empty() || path == "/" {
        return Ok(vec![]);
    }
    if !path.starts_with('/') {
        return Err(Error::pointer(path, "expected an absolute JSON Pointer"));
    }
    path[1..]
        .split('/')
        .map(|token| {
            let mut result = String::new();
            let mut chars = token.chars();
            while let Some(ch) = chars.next() {
                if ch == '~' {
                    match chars.next() {
                        Some('0') => result.push('~'),
                        Some('1') => result.push('/'),
                        _ => return Err(Error::pointer(path, "invalid JSON Pointer escape")),
                    }
                } else {
                    result.push(ch)
                }
            }
            Ok(result)
        })
        .collect()
}
fn is_numeric(token: &str) -> bool {
    !(token.is_empty() || token.len() > 1 && token.starts_with('0'))
        && token.bytes().all(|b| b.is_ascii_digit())
}
fn index(token: &str, path: &str) -> Result<usize> {
    if !is_numeric(token) {
        return Err(Error::pointer(path, "expected a canonical array index"));
    }
    token
        .parse()
        .map_err(|_| Error::pointer(path, "array index is too large"))
}
fn apply(
    node: &mut ModelValue,
    tokens: &[String],
    value: &DataModelUpdate,
    path: &str,
    remaining: &mut usize,
) -> Result<()> {
    let Some((token, rest)) = tokens.split_first() else {
        *node = match value {
            DataModelUpdate::Set(v) => v.clone().into(),
            DataModelUpdate::Remove => ModelValue::Undefined,
        };
        return Ok(());
    };
    if matches!(node, ModelValue::Undefined | ModelValue::Null) {
        *node = if is_numeric(token) {
            ModelValue::Array(Vec::new())
        } else {
            ModelValue::Object(BTreeMap::new())
        };
    }
    match node {
        ModelValue::Object(map) => {
            if rest.is_empty() && matches!(value, DataModelUpdate::Remove) {
                map.remove(token);
                return Ok(());
            }
            apply(
                map.entry(token.clone()).or_insert(ModelValue::Undefined),
                rest,
                value,
                path,
                remaining,
            )
        }
        ModelValue::Array(array) => {
            let i = index(token, path)?;
            if i >= array.len() {
                let len = i
                    .checked_add(1)
                    .ok_or_else(|| Error::pointer(path, "array index is too large"))?;
                let added = len - array.len();
                if added > *remaining {
                    return Err(Error::pointer(
                        path,
                        "implicit array growth exceeds the configured slot budget",
                    ));
                }
                array
                    .try_reserve(added)
                    .map_err(|e| Error::pointer(path, e))?;
                *remaining -= added;
                array.resize(len, ModelValue::Undefined);
            }
            apply(&mut array[i], rest, value, path, remaining)
        }
        _ => Err(Error::pointer(path, "path walks through a scalar value")),
    }
}
