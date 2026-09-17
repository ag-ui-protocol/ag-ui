//! Building the operation stream that renders a surface.
//!
//! Three builders plus [`assemble_ops`], which puts them in the order a
//! renderer expects: create the surface, define its components, then supply the
//! data.
//!
//! # `intent = "update"` must not re-create the surface
//!
//! `createSurface` allocates a `surfaceId` and fixes its catalog. Sending it
//! again for a surface that already exists is an error per spec — the renderer
//! rejects it, and the frontend surfaces that failure to the user. Editing an
//! existing surface therefore means sending only `updateComponents` and
//! `updateDataModel`. [`Intent::Update`] encodes exactly that.

use serde_json::Value;

use crate::constants::{BASIC_CATALOG_ID, DEFAULT_SURFACE_ID};
use crate::message::{AgentMessage, Component};

/// Whether the caller is building a new surface or editing one that exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Intent {
    /// Build a surface that does not exist yet.
    #[default]
    Create,
    /// Edit a surface the renderer already holds.
    Update,
}

impl Intent {
    /// Parses the wire spelling, case-insensitively.
    ///
    /// Anything unrecognized is `None` rather than a silent default: guessing
    /// wrong in the "update" direction re-creates a live surface.
    pub fn from_wire(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "create" | "new" => Some(Intent::Create),
            "update" | "edit" => Some(Intent::Update),
            _ => None,
        }
    }

    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Intent::Create => "create",
            Intent::Update => "update",
        }
    }

    /// Whether a `createSurface` operation belongs in this stream.
    pub fn needs_create_surface(self) -> bool {
        matches!(self, Intent::Create)
    }
}

impl std::fmt::Display for Intent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What a surface should look like, as the authoring layer sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct SurfaceSpec {
    /// Target surface id. Defaults to [`DEFAULT_SURFACE_ID`].
    pub surface_id: String,
    /// Catalog the components are drawn from. Defaults to [`BASIC_CATALOG_ID`].
    pub catalog_id: String,
    /// The flat component adjacency list.
    pub components: Vec<Component>,
    /// Initial or updated data model. `None` sends no data operation.
    pub data_model: Option<Value>,
    /// Where the data model is written.
    ///
    /// Defaults to `/`, which replaces the whole model. When updating a live
    /// surface, prefer a narrower pointer: the renderer's two-way bindings write
    /// user input straight into this model, and replacing the root discards it.
    pub data_path: String,
    /// Optional catalog-defined theme for `createSurface`.
    pub theme: Option<Value>,
    /// Ask the renderer to echo the data model back with every message.
    pub send_data_model: Option<bool>,
}

impl Default for SurfaceSpec {
    fn default() -> Self {
        Self {
            surface_id: DEFAULT_SURFACE_ID.to_string(),
            catalog_id: BASIC_CATALOG_ID.to_string(),
            components: Vec::new(),
            data_model: None,
            data_path: "/".to_string(),
            theme: None,
            send_data_model: None,
        }
    }
}

impl SurfaceSpec {
    /// A spec for the given surface with default catalog and no content.
    pub fn new(surface_id: impl Into<String>) -> Self {
        Self {
            surface_id: surface_id.into(),
            ..Self::default()
        }
    }

    /// Sets the component list.
    #[must_use]
    pub fn with_components(mut self, components: Vec<Component>) -> Self {
        self.components = components;
        self
    }

    /// Sets the data model, written at [`SurfaceSpec::data_path`].
    #[must_use]
    pub fn with_data_model(mut self, data_model: Value) -> Self {
        self.data_model = Some(data_model);
        self
    }

    /// Sets the catalog id.
    #[must_use]
    pub fn with_catalog_id(mut self, catalog_id: impl Into<String>) -> Self {
        self.catalog_id = catalog_id.into();
        self
    }

    /// Sets the pointer the data model is written at.
    #[must_use]
    pub fn with_data_path(mut self, data_path: impl Into<String>) -> Self {
        self.data_path = data_path.into();
        self
    }
}

/// Builds a `createSurface` operation.
pub fn create_surface(
    surface_id: impl Into<String>,
    catalog_id: impl Into<String>,
    theme: Option<Value>,
    send_data_model: Option<bool>,
) -> AgentMessage {
    let mut message = AgentMessage::create_surface(surface_id, catalog_id);
    if let crate::message::AgentPayload::CreateSurface(payload) = &mut message.payload {
        payload.theme = theme;
        payload.send_data_model = send_data_model;
    }
    message
}

/// Builds an `updateComponents` operation.
pub fn update_components(
    surface_id: impl Into<String>,
    components: Vec<Component>,
) -> AgentMessage {
    AgentMessage::update_components(surface_id, components)
}

/// Builds an `updateDataModel` operation.
///
/// A `null` value is stored explicitly; a `path` of `/` replaces the whole
/// data model.
pub fn update_data_model(
    surface_id: impl Into<String>,
    path: impl Into<String>,
    value: Value,
) -> AgentMessage {
    AgentMessage::update_data_model(surface_id, path, value)
}

/// Assembles the full operation stream for a surface.
///
/// Order is `createSurface` (create intent only) → `updateComponents` →
/// `updateDataModel`, so the renderer has a surface to attach to, then a tree to
/// draw, then data to fill it with. Empty components or an absent data model
/// simply omit that operation.
///
/// ```
/// use ag_ui_a2ui::toolkit::ops::{assemble_ops, Intent, SurfaceSpec};
/// use ag_ui_a2ui::message::Component;
/// use serde_json::json;
///
/// let spec = SurfaceSpec::new("cart")
///     .with_components(vec![Component::new("root", "Text").with("text", json!("hi"))]);
///
/// assert_eq!(assemble_ops(Intent::Create, &spec).len(), 2);
/// // Updating an existing surface must not re-create it.
/// assert_eq!(assemble_ops(Intent::Update, &spec).len(), 1);
/// ```
pub fn assemble_ops(intent: Intent, spec: &SurfaceSpec) -> Vec<AgentMessage> {
    let mut ops = Vec::with_capacity(3);

    if intent.needs_create_surface() {
        ops.push(create_surface(
            &spec.surface_id,
            &spec.catalog_id,
            spec.theme.clone(),
            spec.send_data_model,
        ));
    }
    if !spec.components.is_empty() {
        ops.push(update_components(&spec.surface_id, spec.components.clone()));
    }
    if let Some(data_model) = &spec.data_model {
        ops.push(update_data_model(
            &spec.surface_id,
            &spec.data_path,
            data_model.clone(),
        ));
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::AgentPayload;
    use serde_json::json;

    fn spec() -> SurfaceSpec {
        SurfaceSpec::new("s1")
            .with_components(vec![
                Component::new("root", "Text").with("text", json!("hello")),
            ])
            .with_data_model(json!({"a": 1}))
    }

    #[test]
    fn create_emits_all_three_operations_in_order() {
        let ops = assemble_ops(Intent::Create, &spec());
        let kinds: Vec<&str> = ops
            .iter()
            .map(|op| match op.payload {
                AgentPayload::CreateSurface(_) => "create",
                AgentPayload::UpdateComponents(_) => "components",
                AgentPayload::UpdateDataModel(_) => "data",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["create", "components", "data"]);
    }

    #[test]
    fn update_never_emits_create_surface() {
        let ops = assemble_ops(Intent::Update, &spec());
        assert!(
            !ops.iter()
                .any(|op| matches!(op.payload, AgentPayload::CreateSurface(_))),
            "updating an existing surface must not re-create it"
        );
        assert_eq!(ops.len(), 2);
    }

    #[test]
    fn empty_content_omits_its_operation() {
        let bare = SurfaceSpec::new("s1");
        assert_eq!(assemble_ops(Intent::Update, &bare).len(), 0);
        assert_eq!(assemble_ops(Intent::Create, &bare).len(), 1);
    }

    #[test]
    fn defaults_come_from_the_wire_constants() {
        let spec = SurfaceSpec::default();
        assert_eq!(spec.surface_id, DEFAULT_SURFACE_ID);
        assert_eq!(spec.catalog_id, BASIC_CATALOG_ID);
        assert_eq!(spec.data_path, "/");
    }

    #[test]
    fn theme_and_send_data_model_ride_on_create_surface() {
        let mut spec = spec();
        spec.theme = Some(json!({"primaryColor": "#00BFFF"}));
        spec.send_data_model = Some(true);
        let ops = assemble_ops(Intent::Create, &spec);
        let AgentPayload::CreateSurface(payload) = &ops[0].payload else {
            panic!("expected createSurface");
        };
        assert_eq!(payload.theme, Some(json!({"primaryColor": "#00BFFF"})));
        assert_eq!(payload.send_data_model, Some(true));
    }

    #[test]
    fn a_narrower_data_path_is_preserved() {
        let spec = SurfaceSpec::new("s1")
            .with_data_model(json!("Ada"))
            .with_data_path("/user/name");
        let ops = assemble_ops(Intent::Update, &spec);
        let AgentPayload::UpdateDataModel(payload) = &ops[0].payload else {
            panic!("expected updateDataModel");
        };
        assert_eq!(payload.path, "/user/name");
    }

    #[test]
    fn intent_parses_the_wire_spellings_and_rejects_the_rest() {
        assert_eq!(Intent::from_wire("create"), Some(Intent::Create));
        assert_eq!(Intent::from_wire("  UPDATE "), Some(Intent::Update));
        assert_eq!(Intent::from_wire("edit"), Some(Intent::Update));
        assert_eq!(Intent::from_wire("replace"), None);
        assert_eq!(Intent::default(), Intent::Create);
    }
}
