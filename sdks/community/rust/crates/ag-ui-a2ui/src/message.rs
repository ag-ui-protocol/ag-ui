//! A2UI protocol envelopes.
//!
//! A2UI is a stream of JSON objects in two directions. Each object carries a
//! `version` discriminator plus exactly one payload key:
//!
//! | Direction | Payload keys |
//! |---|---|
//! | agent → renderer | `createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface` |
//! | renderer → agent | `action`, `error` |
//!
//! # The adjacency-list component model
//!
//! Components are sent as a **flat list**. Parent/child links are ID references,
//! never nesting — a `Card` names its child by id, a `Column` holds an array of
//! ids. The renderer stores every component in a map and rebuilds the tree at
//! render time, which is what lets the agent stream definitions in any order and
//! lets the renderer start painting as soon as `root` arrives.
//!
//! ```
//! use ag_ui_a2ui::message::{AgentMessage, Component};
//! use serde_json::json;
//!
//! let msg = AgentMessage::update_components(
//!     "profile",
//!     vec![
//!         Component::new("root", "Column").with("children", json!(["name"])),
//!         Component::new("name", "Text").with("text", json!("Ada")),
//!     ],
//! );
//! let wire = serde_json::to_value(&msg).unwrap();
//! assert_eq!(wire["version"], "v0.9");
//! assert_eq!(wire["updateComponents"]["components"][0]["component"], "Column");
//! ```

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::constants::PROTOCOL_VERSION;

/// Supported A2UI server-message profiles. Candidate v1.0 RPC is excluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum A2uiVersion {
    /// v0.9 wire discriminator, also accepted by the v0.9.1 schema.
    #[serde(rename = "v0.9")]
    V0_9,
    /// v0.9.1 discriminator.
    #[serde(rename = "v0.9.1")]
    V0_9_1,
}
impl A2uiVersion {
    /// The exact wire discriminator.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::V0_9 => "v0.9",
            Self::V0_9_1 => "v0.9.1",
        }
    }
}

use crate::error::Result;

fn serialize_version<S: serde::Serializer>(
    version: &str,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    if !matches!(version, "v0.9" | "v0.9.1") {
        return Err(serde::ser::Error::custom("unsupported A2UI version"));
    }
    serializer.serialize_str(version)
}
fn deserialize_version<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<String, D::Error> {
    let version = String::deserialize(deserializer)?;
    if !matches!(version.as_str(), "v0.9" | "v0.9.1") {
        return Err(serde::de::Error::custom("unsupported A2UI version"));
    }
    Ok(version)
}
fn default_version() -> String {
    PROTOCOL_VERSION.to_string()
}

/// One agent → renderer message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentMessage {
    /// Protocol version stamped on the wire; defaults to
    /// [`PROTOCOL_VERSION`].
    #[serde(
        serialize_with = "serialize_version",
        deserialize_with = "deserialize_version"
    )]
    pub version: String,
    /// The single payload key that gives this message its type.
    #[serde(flatten)]
    pub payload: AgentPayload,
}

impl AgentMessage {
    /// Wraps a payload with the current protocol version.
    pub fn new(payload: AgentPayload) -> Self {
        Self {
            version: default_version(),
            payload,
        }
    }

    /// `createSurface`: allocate a surface and fix its `catalogId`.
    ///
    /// Re-creating a `surfaceId` that already exists is an error per spec; see
    #[cfg_attr(
        feature = "toolkit",
        doc = "[`crate::toolkit::ops::assemble_ops`], which omits this message when the"
    )]
    #[cfg_attr(
        not(feature = "toolkit"),
        doc = "`toolkit::ops::assemble_ops` (behind the `toolkit` feature), which omits this message when the"
    )]
    /// intent is to update an existing surface.
    pub fn create_surface(surface_id: impl Into<String>, catalog_id: impl Into<String>) -> Self {
        Self::new(AgentPayload::CreateSurface(CreateSurface {
            surface_id: surface_id.into(),
            catalog_id: catalog_id.into(),
            theme: None,
            send_data_model: None,
        }))
    }

    /// `updateComponents`: add or replace components on an existing surface.
    pub fn update_components(surface_id: impl Into<String>, components: Vec<Component>) -> Self {
        Self::new(AgentPayload::UpdateComponents(UpdateComponents {
            surface_id: surface_id.into(),
            components,
        }))
    }

    /// `updateDataModel`: upsert `value` at `path` (JSON Pointer, `/` = whole model).
    pub fn update_data_model(
        surface_id: impl Into<String>,
        path: impl Into<String>,
        value: Value,
    ) -> Self {
        Self::new(AgentPayload::UpdateDataModel(UpdateDataModel {
            surface_id: surface_id.into(),
            path: path.into(),
            value: DataModelUpdate::Set(value),
        }))
    }

    /// Removes a data-model location by omitting the wire `value` field.
    pub fn remove_data_model_value(surface_id: impl Into<String>, path: impl Into<String>) -> Self {
        Self::new(AgentPayload::UpdateDataModel(UpdateDataModel {
            surface_id: surface_id.into(),
            path: path.into(),
            value: DataModelUpdate::Remove,
        }))
    }

    /// Selects the supported wire version explicitly.
    #[must_use]
    pub fn with_version(mut self, version: A2uiVersion) -> Self {
        self.version = version.as_str().into();
        self
    }

    /// `deleteSurface`: drop a surface and everything under it.
    pub fn delete_surface(surface_id: impl Into<String>) -> Self {
        Self::new(AgentPayload::DeleteSurface(DeleteSurface {
            surface_id: surface_id.into(),
        }))
    }

    /// The `surfaceId` this message targets, if it targets one.
    ///
    /// Function-call messages are addressed by `functionCallId` rather than by
    /// surface, so they return `None`.
    pub fn surface_id(&self) -> Option<&str> {
        match &self.payload {
            AgentPayload::CreateSurface(m) => Some(&m.surface_id),
            AgentPayload::UpdateComponents(m) => Some(&m.surface_id),
            AgentPayload::UpdateDataModel(m) => Some(&m.surface_id),
            AgentPayload::DeleteSurface(m) => Some(&m.surface_id),
            AgentPayload::CallRendererFunction(_) | AgentPayload::AgentFunctionResponse(_) => None,
        }
    }
}

/// The payload of an [`AgentMessage`], externally tagged by its wire key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentPayload {
    /// Create a surface and fix its catalog.
    CreateSurface(CreateSurface),
    /// Add or replace components on a surface.
    UpdateComponents(UpdateComponents),
    /// Upsert part of a surface's data model.
    UpdateDataModel(UpdateDataModel),
    /// Remove a surface entirely.
    DeleteSurface(DeleteSurface),
    /// Candidate RPC shape, excluded from v0.9-family serialization/deserialization.
    #[serde(skip)]
    CallRendererFunction(CallRendererFunction),
    /// Candidate RPC response, excluded from v0.9-family serialization/deserialization.
    #[serde(skip)]
    AgentFunctionResponse(FunctionResponse),
}

/// Payload of a `createSurface` message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSurface {
    /// Surface identifier, unique among active surfaces in this renderer context.
    pub surface_id: String,
    /// Opaque identifier of the component catalog this surface speaks.
    ///
    /// Fixed for the life of the surface: changing it means deleting and
    /// recreating the surface.
    pub catalog_id: String,
    /// Catalog-defined theme parameters (`primaryColor`, `iconUrl`, ...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<Value>,
    /// Ask the renderer to echo this surface's whole data model back with every
    /// message it sends to the creating agent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub send_data_model: Option<bool>,
}

/// Payload of an `updateComponents` message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateComponents {
    /// Surface to update. It must already have been created.
    pub surface_id: String,
    /// Flat adjacency list of component definitions.
    pub components: Vec<Component>,
}

/// A2UI v0.9-family data update. Field omission means removal, including
/// undefined array slots. Explicit null is a value.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum DataModelUpdate {
    /// Store the exact JSON value, including null.
    Set(Value),
    /// Remove the target. Serialized by omitting the enclosing `value` field.
    #[default]
    Remove,
}
impl DataModelUpdate {
    /// Whether the update removes a value.
    pub fn is_remove(&self) -> bool {
        matches!(self, Self::Remove)
    }
}
impl Serialize for DataModelUpdate {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Set(v) => v.serialize(serializer),
            Self::Remove => Err(serde::ser::Error::custom(
                "Remove must be serialized as an omitted updateDataModel value",
            )),
        }
    }
}
impl<'de> Deserialize<'de> for DataModelUpdate {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        Ok(Self::Set(Value::deserialize(deserializer)?))
    }
}
/// Payload of an `updateDataModel` message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateDataModel {
    /// Surface whose data model is being updated.
    pub surface_id: String,
    /// Absolute JSON Pointer; `/` and omission denote the whole model.
    #[serde(default = "root_pointer")]
    pub path: String,
    /// A present value is stored; omission removes the target.
    #[serde(default, skip_serializing_if = "DataModelUpdate::is_remove")]
    pub value: DataModelUpdate,
}
fn root_pointer() -> String {
    "/".to_string()
}
impl UpdateDataModel {
    /// Applies an update losslessly, including undefined roots and array slots.
    pub fn apply_model(&self, model: &mut crate::model::DataModel) -> Result<()> {
        model.apply(&self.path, &self.value)
    }
    /// Applies to plain JSON atomically. Undefined results are rejected; use
    /// `apply_model` when deletions can affect array slots or the root.
    pub fn apply(&self, model: &mut Value) -> Result<()> {
        let mut exact = crate::model::DataModel::from(model.clone());
        self.apply_model(&mut exact)?;
        *model = exact.to_json()?;
        Ok(())
    }
}
/// Stores an exact JSON value at a path. Null is stored rather than removed.
/// A failed pointer leaves the original model intact.
pub fn apply_data_model_update(model: &mut Value, path: &str, value: &Value) -> Result<()> {
    UpdateDataModel {
        surface_id: String::new(),
        path: path.into(),
        value: DataModelUpdate::Set(value.clone()),
    }
    .apply(model)
}

/// Payload of a `deleteSurface` message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSurface {
    /// Surface to remove.
    pub surface_id: String,
}

/// Payload of a `callRendererFunction` message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRendererFunction {
    /// Correlation id; the renderer copies it into its response.
    pub function_call_id: String,
    /// The function to invoke, with its arguments.
    pub call_function: FunctionCall,
}

/// Payload of a `callAgentFunction` message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallAgentFunction {
    /// Surface the call originated from.
    pub surface_id: String,
    /// Correlation id; the agent copies it into its response.
    pub function_call_id: String,
    /// The function to invoke, with its arguments.
    pub call_function: FunctionCall,
}

/// A named function invocation, used both in component properties and in the
/// two `call*Function` messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionCall {
    /// Function name, e.g. `formatString`, `required`, `@index`.
    pub call: String,
    /// Named arguments. Values may themselves be bindings or nested calls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Map<String, Value>>,
    /// Catalog the function is drawn from, when it is not the surface default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
    /// Expected return type, used to disambiguate overloads on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_type: Option<String>,
}

/// The result of a `call*Function`, sent back by whichever side ran it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionResponse {
    /// Correlation id copied from the originating call.
    pub function_call_id: String,
    /// Whatever the function returned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Set instead of `result` when the call failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One renderer → agent message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RendererMessage {
    /// Protocol version stamped on the wire.
    #[serde(
        serialize_with = "serialize_version",
        deserialize_with = "deserialize_version"
    )]
    pub version: String,
    /// The single payload key that gives this message its type.
    #[serde(flatten)]
    pub payload: RendererPayload,
}

impl RendererMessage {
    /// Wraps a payload with the current protocol version.
    pub fn new(payload: RendererPayload) -> Self {
        Self {
            version: default_version(),
            payload,
        }
    }

    /// The `surfaceId` this message relates to, if any.
    pub fn surface_id(&self) -> Option<&str> {
        match &self.payload {
            RendererPayload::Action(a) => Some(&a.surface_id),
            RendererPayload::CallAgentFunction(c) => Some(&c.surface_id),
            RendererPayload::RendererFunctionResponse(_) => None,
            RendererPayload::Error(e) => e.surface_id.as_deref(),
        }
    }
}

/// The payload of a [`RendererMessage`], externally tagged by its wire key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RendererPayload {
    /// A user interacted with a component that declares an `action`.
    Action(Action),
    /// The renderer wants the agent to run a function on its behalf.
    #[serde(skip)]
    CallAgentFunction(CallAgentFunction),
    /// Result of an agent-initiated [`AgentPayload::CallRendererFunction`].
    #[serde(skip)]
    RendererFunctionResponse(FunctionResponse),
    /// The renderer is reporting a problem, typically a failed validation.
    Error(RendererError),
}

/// Payload of an `action` message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    /// Action name, taken from the component's `action.event.name`.
    pub name: String,
    /// Surface the interaction happened on.
    pub surface_id: String,
    /// Component that triggered it.
    pub source_component_id: String,
    /// ISO 8601 timestamp of the interaction.
    pub timestamp: String,
    /// The component's `action.event.context` with all bindings resolved.
    #[serde(default)]
    pub context: Map<String, Value>,
    /// Human-readable description of what the user did, if the component
    /// supplied one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_message: Option<String>,
}

/// Payload of an `error` message from the renderer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererError {
    /// Machine-readable code, e.g. `VALIDATION_FAILED`, `UNALLOWED_PARENT`.
    pub code: String,
    /// One or two sentences the agent (or its model) can act on.
    pub message: String,
    /// Surface the error relates to, for surface-scoped errors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_id: Option<String>,
    /// JSON Pointer to the offending field, for validation errors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Correlation id, for errors raised while running a function call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function_call_id: Option<String>,
}

/// One node of the flat component adjacency list.
///
/// `id` and `component` are the only fixed fields; everything else is
/// catalog-defined and lives in [`Component::props`] as raw JSON. The struct
/// flattens back to the wire shape `{"id": ..., "component": "Text", "text": ...}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Component {
    /// Unique id within the surface; other components reference it by this.
    pub id: String,
    /// Component type name, resolved against the surface's catalog.
    pub component: String,
    /// Catalog-defined properties, verbatim.
    #[serde(flatten)]
    pub props: Map<String, Value>,
}

impl Component {
    /// Creates a component with no properties yet.
    pub fn new(id: impl Into<String>, component: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            component: component.into(),
            props: Map::new(),
        }
    }

    /// Sets a property, builder style.
    #[must_use]
    pub fn with(mut self, key: impl Into<String>, value: Value) -> Self {
        self.props.insert(key.into(), value);
        self
    }

    /// Borrows a property by name.
    pub fn prop(&self, key: &str) -> Option<&Value> {
        self.props.get(key)
    }
}

/// How a component declares its children.
///
/// Either a static list of ids, or a template: one component id instantiated
/// once per item of the array at `path`. The template form is what creates a
/// collection scope for relative data bindings (see [`crate::binding`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChildList {
    /// A fixed set of child component ids.
    Ids(Vec<String>),
    /// A template instantiated once per element of a bound array.
    Template(ChildTemplate),
}

/// The template form of a [`ChildList`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildTemplate {
    /// Id of the component to instantiate per item.
    pub component_id: String,
    /// JSON Pointer to the array to iterate.
    pub path: String,
}

impl ChildList {
    /// Parses a raw `children` property value, if it is a well-formed child list.
    pub fn from_value(value: &Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }

    /// Every component id this child list references.
    pub fn referenced_ids(&self) -> Vec<&str> {
        match self {
            ChildList::Ids(ids) => ids.iter().map(String::as_str).collect(),
            ChildList::Template(t) => vec![t.component_id.as_str()],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_message_round_trips_through_the_wire_shape() {
        let msg = AgentMessage::create_surface("s1", "cat");
        let wire = serde_json::to_value(&msg).unwrap();
        assert_eq!(
            wire,
            json!({"version": "v0.9", "createSurface": {"surfaceId": "s1", "catalogId": "cat"}})
        );
        let back: AgentMessage = serde_json::from_value(wire).unwrap();
        assert_eq!(back, msg);
    }

    #[test]
    fn components_keep_catalog_props_flat() {
        let wire = json!({"id": "t", "component": "Text", "text": "hi", "variant": "h1"});
        let c: Component = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(c.prop("variant"), Some(&json!("h1")));
        assert_eq!(serde_json::to_value(&c).unwrap(), wire);
    }

    #[test]
    fn update_data_model_defaults_path_to_root() {
        let msg: AgentMessage = serde_json::from_value(json!({
            "version": "v0.9",
            "updateDataModel": {"surfaceId": "s", "value": {"a": 1}}
        }))
        .unwrap();
        let AgentPayload::UpdateDataModel(m) = msg.payload else {
            panic!("expected updateDataModel");
        };
        assert_eq!(m.path, "/");
    }

    #[test]
    fn upsert_creates_missing_intermediates_and_stores_null() {
        let mut model = json!({});
        apply_data_model_update(&mut model, "/user/name", &json!("Ada")).unwrap();
        assert_eq!(model, json!({"user": {"name": "Ada"}}));

        apply_data_model_update(&mut model, "/user/name", &Value::Null).unwrap();
        assert_eq!(model, json!({"user": {"name":null}}));

        apply_data_model_update(&mut model, "/", &json!({"replaced": true})).unwrap();
        assert_eq!(model, json!({"replaced": true}));
    }

    #[test]
    fn upsert_into_arrays_preserves_length_on_delete() {
        let mut model = json!({"items": [1, 2, 3]});
        apply_data_model_update(&mut model, "/items/1", &Value::Null).unwrap();
        assert_eq!(model, json!({"items": [1, null, 3]}));

        apply_data_model_update(&mut model, "/items/3", &json!(4)).unwrap();
        assert_eq!(model, json!({"items": [1, null, 3, 4]}));

        let err = apply_data_model_update(&mut model, "/items/nope", &json!(0)).unwrap_err();
        assert!(matches!(err, crate::Error::Pointer { .. }));
    }

    #[test]
    fn escaped_pointer_tokens_are_decoded() {
        let mut model = json!({});
        apply_data_model_update(&mut model, "/a~1b", &json!(1)).unwrap();
        assert_eq!(model, json!({"a/b": 1}));
    }

    #[test]
    fn child_list_parses_both_forms() {
        assert_eq!(
            ChildList::from_value(&json!(["a", "b"]))
                .unwrap()
                .referenced_ids(),
            vec!["a", "b"]
        );
        assert_eq!(
            ChildList::from_value(&json!({"componentId": "tpl", "path": "/items"}))
                .unwrap()
                .referenced_ids(),
            vec!["tpl"]
        );
        assert!(ChildList::from_value(&json!("nope")).is_none());
    }

    #[test]
    fn renderer_messages_round_trip() {
        let wire = json!({
            "version": "v0.9",
            "action": {
                "name": "submit",
                "surfaceId": "s1",
                "sourceComponentId": "btn",
                "timestamp": "2026-01-01T00:00:00Z",
                "context": {"email": "a@b.c"}
            }
        });
        let msg: RendererMessage = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(msg.surface_id(), Some("s1"));
        assert_eq!(serde_json::to_value(&msg).unwrap(), wire);
    }
}
