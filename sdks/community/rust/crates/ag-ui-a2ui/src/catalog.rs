//! Component catalogs: what a surface is allowed to contain.
//!
//! A catalog names the component types and functions a surface may use, the
//! properties each component takes, which of those properties are structural
//! (they hold component ids rather than data), and any composition constraints.
//! Agent and renderer must agree on one, identified by an opaque `catalogId`.
//!
//! Two ways in:
//!
//! - [`Catalog::basic`] — the 18-component standard catalog, built in.
//! - [`Catalog::from_schema`] — parse any A2UI catalog JSON Schema document,
//!   which is how custom design systems are described.
//!
//! # Structural properties are what make validation possible
//!
//! The specification is explicit that a catalog must type child references as
//! `ComponentId` or `ChildList` rather than as bare strings — a validator
//! decides which fields are structural links by looking for exactly those
//! references. A raw `"type": "string"` is treated as static text (a URL, a
//! label) and its target is never checked. [`PropKind`] preserves that
//! distinction.
//!
//! # Property types are carried, not interpreted
//!
//! Each property also keeps the JSON type its schema pins it to ([`PropType`]),
//! which is what lets [`crate::validate`] reject `{"columns": "three"}` where the
//! catalog says integer. That is one constraint out of JSON Schema, not an
//! engine: `pattern`, `minimum`, `additionalProperties` and the rest are left to
//! whatever validates the document itself. A property whose schema states no
//! type, or states several, is [`PropType::Unconstrained`] and is never rejected
//! — a catalog this crate reads loosely must not turn into false failures.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::constants::{BASIC_CATALOG_ID, ROOT_ID, SURFACE_COMPONENT};
use crate::error::{Error, Result};
use crate::message::Component;

/// Component types of the basic catalog, in specification order.
pub const BASIC_COMPONENTS: [&str; 18] = [
    "Text",
    "Image",
    "Icon",
    "Video",
    "AudioPlayer",
    "Row",
    "Column",
    "List",
    "Card",
    "Tabs",
    "Divider",
    "Modal",
    "Button",
    "CheckBox",
    "TextField",
    "DateTimeInput",
    "ChoicePicker",
    "Slider",
];

/// Function names of the basic catalog.
pub const BASIC_FUNCTIONS: [&str; 14] = [
    "required",
    "regex",
    "length",
    "numeric",
    "email",
    "formatString",
    "formatNumber",
    "formatCurrency",
    "formatDate",
    "pluralize",
    "openUrl",
    "and",
    "or",
    "not",
];

/// Icon names the basic catalog's `Icon` component accepts.
pub const BASIC_ICON_NAMES: [&str; 59] = [
    "accountCircle",
    "add",
    "arrowBack",
    "arrowForward",
    "attachFile",
    "calendarToday",
    "call",
    "camera",
    "check",
    "close",
    "delete",
    "download",
    "edit",
    "event",
    "error",
    "fastForward",
    "favorite",
    "favoriteOff",
    "folder",
    "help",
    "home",
    "info",
    "locationOn",
    "lock",
    "lockOpen",
    "mail",
    "menu",
    "moreVert",
    "moreHoriz",
    "notificationsOff",
    "notifications",
    "pause",
    "payment",
    "person",
    "phone",
    "photo",
    "play",
    "print",
    "refresh",
    "rewind",
    "search",
    "send",
    "settings",
    "share",
    "shoppingCart",
    "skipNext",
    "skipPrevious",
    "star",
    "starHalf",
    "starOff",
    "stop",
    "upload",
    "visibility",
    "visibilityOff",
    "volumeDown",
    "volumeMute",
    "volumeOff",
    "volumeUp",
    "warning",
];

/// Optional properties every component carries, whatever its type.
///
/// `id` and `component` live on [`Component`] itself. These two come from the
/// shared `ComponentCommon` fragments rather than from any one component's
/// definition, so a catalog does not redeclare them per type. (`checks` is not
/// here: it belongs only to input components, and is declared on each.)
pub const COMMON_PROPS: [&str; 2] = ["accessibility", "weight"];

/// How a component property participates in the component graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropKind {
    /// A literal or data-bound value. Never a structural link.
    Value,
    /// A single component id (`common_types.json#/$defs/ComponentId`).
    ComponentRef,
    /// A `ChildList`: either an array of component ids or a template object.
    ChildList,
    /// An array of objects, where the named keys each hold a component id.
    ///
    /// `Tabs.tabs` is the canonical case: `[{title, child}, ...]`.
    ObjectListRefs {
        /// Keys within each array element that hold a component id.
        ref_keys: Vec<String>,
    },
}

impl PropKind {
    /// Whether this property can point at other components.
    pub fn is_structural(&self) -> bool {
        !matches!(self, PropKind::Value)
    }
}

/// The JSON type a property's schema pins its value to.
///
/// Populated from a bare `"type"` in the property schema, or from a `$ref` to
/// one of the common types, which name a JSON type and a data binding together:
/// `DynamicString` is "a string *or* a `{"path": …}`". The binding half needs no
/// representation here because a binding carries the renderer's value, not the
/// property's, so [`crate::validate`] skips bound values entirely.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PropType {
    /// The schema pins no single type, so no value is ever rejected.
    #[default]
    Unconstrained,
    /// `"type": "string"`, `ComponentId`, `DynamicString`.
    String,
    /// `"type": "number"`, `DynamicNumber`.
    Number,
    /// `"type": "integer"`, which also accepts a whole number written `2.0`.
    Integer,
    /// `"type": "boolean"`, `DynamicBoolean`.
    Boolean,
    /// `"type": "object"`, `Action`.
    Object,
    /// `"type": "array"`, `DynamicStringList`.
    Array,
}

impl PropType {
    /// Whether `value` satisfies this type.
    ///
    /// An [`PropType::Unconstrained`] property accepts anything. `null` is
    /// accepted by every type: an explicit null is how a payload clears an
    /// optional property, and a required one missing is
    /// [`ErrorCode::MissingRequiredProp`](crate::validate::ErrorCode) rather
    /// than a type failure.
    pub fn accepts(self, value: &Value) -> bool {
        match self {
            PropType::Unconstrained => true,
            _ if value.is_null() => true,
            PropType::String => value.is_string(),
            PropType::Number => value.is_number(),
            // Matches JSON Schema, where 2.0 is an integer and 2.5 is not.
            PropType::Integer => value.as_f64().is_some_and(|n| n.fract() == 0.0),
            PropType::Boolean => value.is_boolean(),
            PropType::Object => value.is_object(),
            PropType::Array => value.is_array(),
        }
    }

    /// The type as a noun phrase, for error messages.
    pub fn describe(self) -> &'static str {
        match self {
            PropType::Unconstrained => "any value",
            PropType::String => "a string",
            PropType::Number => "a number",
            PropType::Integer => "an integer",
            PropType::Boolean => "a boolean",
            PropType::Object => "an object",
            PropType::Array => "an array",
        }
    }

    /// Reads the JSON Schema spelling of a type.
    fn from_schema_name(name: &str) -> Self {
        match name {
            "string" => PropType::String,
            "number" => PropType::Number,
            "integer" => PropType::Integer,
            "boolean" => PropType::Boolean,
            "object" => PropType::Object,
            "array" => PropType::Array,
            // Includes "null": a property that may only be null constrains
            // nothing worth reporting.
            _ => PropType::Unconstrained,
        }
    }
}

/// One property of a component type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropDef {
    /// Property name as it appears on the wire.
    pub name: String,
    /// Whether the property holds data or component references.
    pub kind: PropKind,
    /// The JSON type the schema pins the value to, if it pins one.
    pub value_type: PropType,
    /// Human-readable description, carried into generated prompts.
    pub description: Option<String>,
    /// Permitted values, when the schema constrains them to an enum.
    pub enum_values: Vec<String>,
    /// Whether the component is invalid without this property.
    pub required: bool,
}

impl PropDef {
    fn new(name: &str, kind: PropKind, required: bool) -> Self {
        Self {
            name: name.to_string(),
            kind,
            value_type: PropType::Unconstrained,
            description: None,
            enum_values: Vec::new(),
            required,
        }
    }

    fn typed(mut self, value_type: PropType) -> Self {
        self.value_type = value_type;
        self
    }

    fn described(mut self, description: &str) -> Self {
        self.description = Some(description.to_string());
        self
    }

    fn with_enum(mut self, values: &[&str]) -> Self {
        self.enum_values = values.iter().map(|v| (*v).to_string()).collect();
        self
    }
}

/// One component type in a catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentDef {
    /// Type name, e.g. `Text`.
    pub name: String,
    /// Human-readable description, carried into generated prompts.
    pub description: Option<String>,
    /// Properties, keyed by name.
    pub props: BTreeMap<String, PropDef>,
    /// Property names that must be present, in declaration order.
    pub required: Vec<String>,
    /// Parent component types this may sit under. `None` means unrestricted.
    ///
    /// [`SURFACE_COMPONENT`] stands for the
    /// implicit surface container, so `["Surface"]` restricts a component to
    /// being the tree root.
    pub allowed_parents: Option<Vec<String>>,
    /// Child component types this may contain. `None` means unrestricted.
    pub allowed_children: Option<Vec<String>>,
    /// Declaration order of properties, for stable prompt rendering.
    prop_order: Vec<String>,
}

impl ComponentDef {
    fn new(name: &str, description: &str, props: Vec<PropDef>) -> Self {
        let required = props
            .iter()
            .filter(|p| p.required)
            .map(|p| p.name.clone())
            .collect();
        let prop_order = props.iter().map(|p| p.name.clone()).collect();
        let props = props.into_iter().map(|p| (p.name.clone(), p)).collect();
        Self {
            name: name.to_string(),
            description: Some(description.to_string()),
            props,
            required,
            allowed_parents: None,
            allowed_children: None,
            prop_order,
        }
    }

    /// Properties in declaration order.
    pub fn props_in_order(&self) -> impl Iterator<Item = &PropDef> {
        self.prop_order
            .iter()
            .filter_map(|name| self.props.get(name))
    }

    /// Every component id a concrete component of this type references.
    ///
    /// Locators are relative to the component object, e.g. `child`,
    /// `children[2]`, `children.componentId`, `tabs[0].child`.
    pub fn references(&self, component: &Component) -> Vec<ComponentRef> {
        let mut refs = Vec::new();
        for (name, def) in &self.props {
            let Some(value) = component.props.get(name) else {
                continue;
            };
            match &def.kind {
                PropKind::Value => {}
                PropKind::ComponentRef => {
                    if let Value::String(id) = value {
                        refs.push(ComponentRef {
                            location: name.clone(),
                            id: id.clone(),
                        });
                    }
                }
                PropKind::ChildList => match value {
                    Value::Array(items) => {
                        for (index, item) in items.iter().enumerate() {
                            if let Value::String(id) = item {
                                refs.push(ComponentRef {
                                    location: format!("{name}[{index}]"),
                                    id: id.clone(),
                                });
                            }
                        }
                    }
                    Value::Object(map) => {
                        if let Some(Value::String(id)) = map.get("componentId") {
                            refs.push(ComponentRef {
                                location: format!("{name}.componentId"),
                                id: id.clone(),
                            });
                        }
                    }
                    _ => {}
                },
                PropKind::ObjectListRefs { ref_keys } => {
                    if let Value::Array(items) = value {
                        for (index, item) in items.iter().enumerate() {
                            let Value::Object(map) = item else { continue };
                            for key in ref_keys {
                                if let Some(Value::String(id)) = map.get(key) {
                                    refs.push(ComponentRef {
                                        location: format!("{name}[{index}].{key}"),
                                        id: id.clone(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        refs.sort_by(|a, b| a.location.cmp(&b.location));
        refs
    }
}

/// One component id reference found inside a component.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentRef {
    /// Where the reference sits within the component, e.g. `children[1]`.
    pub location: String,
    /// The referenced component id.
    pub id: String,
}

/// One function in a catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionDef {
    /// Function name, e.g. `formatString`.
    pub name: String,
    /// Human-readable description, carried into generated prompts.
    pub description: Option<String>,
    /// Declared return type, when the catalog states one.
    pub return_type: Option<String>,
}

/// A set of component and function definitions, identified by `catalogId`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Catalog {
    /// Opaque identifier agent and renderer negotiate on.
    pub catalog_id: String,
    /// Human-readable title.
    pub title: Option<String>,
    /// Human-readable description.
    pub description: Option<String>,
    /// Markdown design guidance specific to this catalog, for prompts.
    pub instructions: Option<String>,
    /// Component types, keyed by name.
    pub components: BTreeMap<String, ComponentDef>,
    /// Functions, keyed by name.
    pub functions: BTreeMap<String, FunctionDef>,
    component_order: Vec<String>,
}

impl Catalog {
    /// An empty catalog with the given id.
    pub fn empty(catalog_id: impl Into<String>) -> Self {
        Self {
            catalog_id: catalog_id.into(),
            title: None,
            description: None,
            instructions: None,
            components: BTreeMap::new(),
            functions: BTreeMap::new(),
            component_order: Vec::new(),
        }
    }

    /// Looks up a component type.
    pub fn component(&self, name: &str) -> Option<&ComponentDef> {
        self.components.get(name)
    }

    /// Whether this catalog defines the given component type.
    pub fn has_component(&self, name: &str) -> bool {
        self.components.contains_key(name)
    }

    /// Component types in declaration order.
    pub fn components_in_order(&self) -> impl Iterator<Item = &ComponentDef> {
        self.component_order
            .iter()
            .filter_map(|name| self.components.get(name))
    }

    /// Adds or replaces a component type.
    pub fn insert_component(&mut self, def: ComponentDef) {
        if !self.components.contains_key(&def.name) {
            self.component_order.push(def.name.clone());
        }
        self.components.insert(def.name.clone(), def);
    }

    /// Every component id referenced by `component`, using this catalog's
    /// structural property definitions.
    ///
    /// Returns an empty list for an unknown component type: without a
    /// definition there is no way to tell a child reference from a label.
    pub fn references(&self, component: &Component) -> Vec<ComponentRef> {
        self.component(&component.component)
            .map(|def| def.references(component))
            .unwrap_or_default()
    }

    /// The standard 18-component basic catalog.
    pub fn basic() -> Self {
        let mut catalog = Self::empty(BASIC_CATALOG_ID);
        catalog.title = Some("A2UI Basic Catalog".to_string());
        catalog.description =
            Some("The baseline set of A2UI components and client-side functions.".to_string());

        for def in basic_component_defs() {
            catalog.insert_component(def);
        }
        for (name, description, return_type) in BASIC_FUNCTION_DEFS {
            catalog.functions.insert(
                name.to_string(),
                FunctionDef {
                    name: name.to_string(),
                    description: Some(description.to_string()),
                    return_type: Some(return_type.to_string()),
                },
            );
        }
        catalog
    }

    /// Parses an A2UI catalog JSON Schema document.
    ///
    /// Understands the shape the specification uses: a top-level `components`
    /// map whose values are JSON Schemas, each typically an `allOf` of shared
    /// fragments plus a final object holding `properties` and `required`. The
    /// `allOf` members are merged; `$ref`s to `ComponentId` and `ChildList` are
    /// what mark a property structural.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Catalog`] if the document is not an object or has no
    /// `catalogId`.
    pub fn from_schema(schema: &Value) -> Result<Self> {
        let root = schema
            .as_object()
            .ok_or_else(|| Error::catalog("catalog document must be a JSON object"))?;

        let catalog_id = root
            .get("catalogId")
            .or_else(|| root.get("$id"))
            .and_then(Value::as_str)
            .ok_or_else(|| Error::catalog("catalog document is missing 'catalogId'"))?;

        let mut catalog = Self::empty(catalog_id);
        catalog.title = string_field(root.get("title"));
        catalog.description = string_field(root.get("description"));
        catalog.instructions = string_field(root.get("instructions"));

        if let Some(Value::Object(components)) = root.get("components") {
            for (name, component_schema) in components {
                catalog.insert_component(component_def_from_schema(name, component_schema));
            }
        }
        if let Some(Value::Object(functions)) = root.get("functions") {
            for (name, function_schema) in functions {
                catalog.functions.insert(
                    name.to_string(),
                    FunctionDef {
                        name: name.to_string(),
                        description: string_field(function_schema.get("description")),
                        return_type: string_field(function_schema.get("returnType")),
                    },
                );
            }
        }
        if let Some(Value::Array(functions)) = root.get("functions") {
            for definition in functions {
                let name = definition
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::catalog("inline function needs a name"))?;
                if catalog.functions.contains_key(name) {
                    return Err(Error::catalog(format!("duplicate function {name}")));
                }
                catalog.functions.insert(
                    name.into(),
                    FunctionDef {
                        name: name.into(),
                        description: string_field(definition.get("description")),
                        return_type: string_field(definition.get("returnType")),
                    },
                );
            }
        }
        Ok(catalog)
    }

    /// Checks `allowedParents` / `allowedChildren` across a component tree.
    ///
    /// Kept separate from [`crate::validate`] on purpose: the specification
    /// assigns composition failures their own renderer-side error codes
    /// (`UNALLOWED_PARENT`, `UNALLOWED_CHILD`), distinct from the structural
    /// validation codes. Components with no declared constraints never produce
    /// violations, which is every component of the basic catalog.
    ///
    /// The root component's parent is the implicit
    /// [`Surface`](crate::constants::SURFACE_COMPONENT) container.
    pub fn composition_violations(&self, components: &[Component]) -> Vec<CompositionViolation> {
        let types: BTreeMap<&str, &str> = components
            .iter()
            .map(|c| (c.id.as_str(), c.component.as_str()))
            .collect();
        let index: BTreeMap<&str, usize> = components
            .iter()
            .enumerate()
            .map(|(i, c)| (c.id.as_str(), i))
            .collect();
        let mut out = Vec::new();

        // The implicit Surface container is the root component's parent.
        if let Some(root) = components.iter().find(|c| c.id == ROOT_ID) {
            if let Some(def) = self.component(&root.component) {
                if let Some(allowed) = &def.allowed_parents {
                    if !allowed.iter().any(|p| p == SURFACE_COMPONENT) {
                        let position = index.get(ROOT_ID).copied().unwrap_or(0);
                        out.push(CompositionViolation {
                            code: CompositionCode::UnallowedParent,
                            path: format!("components[{position}].component"),
                            message: format!(
                                "'{}' cannot be the root of a surface: allowedParents is [{}], \
                                 which does not include '{SURFACE_COMPONENT}'.",
                                root.component,
                                allowed.join(", ")
                            ),
                        });
                    }
                }
            }
        }

        for (position, parent) in components.iter().enumerate() {
            let Some(parent_def) = self.component(&parent.component) else {
                continue;
            };
            for reference in parent_def.references(parent) {
                let Some(child_type) = types.get(reference.id.as_str()) else {
                    continue;
                };
                if let Some(allowed) = &parent_def.allowed_children {
                    if !allowed.iter().any(|c| c == child_type) {
                        out.push(CompositionViolation {
                            code: CompositionCode::UnallowedChild,
                            path: format!("components[{position}].{}", reference.location),
                            message: format!(
                                "'{}' cannot contain '{child_type}': allowedChildren is [{}].",
                                parent.component,
                                allowed.join(", ")
                            ),
                        });
                    }
                }
                if let Some(child_def) = self.component(child_type) {
                    if let Some(allowed) = &child_def.allowed_parents {
                        if !allowed.iter().any(|p| p == &parent.component) {
                            out.push(CompositionViolation {
                                code: CompositionCode::UnallowedParent,
                                path: format!("components[{position}].{}", reference.location),
                                message: format!(
                                    "'{child_type}' cannot sit under '{}': allowedParents is [{}].",
                                    parent.component,
                                    allowed.join(", ")
                                ),
                            });
                        }
                    }
                }
            }
        }
        out
    }

    /// Renders the catalog as a compact summary for a generating model.
    ///
    /// One line per component with its required and optional properties, plus
    /// the function list. This is the cheap alternative to pasting the whole
    /// JSON Schema; when a model needs the exact document instead, use
    #[cfg_attr(
        feature = "toolkit",
        doc = "[`SchemaBundle::render_llm_instructions`](crate::toolkit::schema::SchemaBundle::render_llm_instructions)."
    )]
    #[cfg_attr(
        not(feature = "toolkit"),
        doc = "`SchemaBundle::render_llm_instructions`, behind the `toolkit` feature."
    )]
    pub fn render_summary(&self) -> String {
        let mut out = String::new();
        out.push_str("### Component catalog\n");
        out.push_str(&format!("catalogId: {}\n", self.catalog_id));
        if let Some(instructions) = &self.instructions {
            out.push_str(instructions);
            out.push('\n');
        }
        out.push_str(
            "Every component object is `{\"id\": <unique id>, \"component\": <type>, ...props}`. \
             Children are referenced by id; components are never nested inline.\n\n",
        );
        for def in self.components_in_order() {
            out.push_str(&format!("- {}", def.name));
            let required: Vec<String> = def
                .props_in_order()
                .filter(|p| p.required)
                .map(describe_prop)
                .collect();
            let optional: Vec<String> = def
                .props_in_order()
                .filter(|p| !p.required)
                .map(describe_prop)
                .collect();
            if !required.is_empty() {
                out.push_str(&format!(" required: {}", required.join(", ")));
            }
            if !optional.is_empty() {
                out.push_str(&format!("; optional: {}", optional.join(", ")));
            }
            if let Some(allowed) = &def.allowed_parents {
                out.push_str(&format!("; allowedParents: [{}]", allowed.join(", ")));
            }
            if let Some(allowed) = &def.allowed_children {
                out.push_str(&format!("; allowedChildren: [{}]", allowed.join(", ")));
            }
            out.push('\n');
        }
        if !self.functions.is_empty() {
            let names: Vec<&str> = self.functions.keys().map(String::as_str).collect();
            out.push_str(&format!("\nFunctions: {}\n", names.join(", ")));
        }
        out
    }
}

fn describe_prop(prop: &PropDef) -> String {
    let kind = match &prop.kind {
        PropKind::Value if !prop.enum_values.is_empty() => {
            format!("one of [{}]", prop.enum_values.join("|"))
        }
        PropKind::Value => "value".to_string(),
        PropKind::ComponentRef => "component id".to_string(),
        PropKind::ChildList => "component ids or {componentId, path}".to_string(),
        PropKind::ObjectListRefs { ref_keys } => {
            format!(
                "array of objects with component id in {}",
                ref_keys.join("/")
            )
        }
    };
    format!("{} ({kind})", prop.name)
}

/// A composition-constraint failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompositionViolation {
    /// Which constraint was broken.
    pub code: CompositionCode,
    /// Locator into the components list, e.g. `components[3].children[0]`.
    pub path: String,
    /// Human- and LLM-readable explanation.
    pub message: String,
}

/// Error codes the specification assigns to composition failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositionCode {
    /// A component sits under a parent its `allowedParents` excludes.
    UnallowedParent,
    /// A container holds a child its `allowedChildren` excludes.
    UnallowedChild,
}

impl CompositionCode {
    /// The wire string for this code.
    pub fn as_str(self) -> &'static str {
        match self {
            CompositionCode::UnallowedParent => "UNALLOWED_PARENT",
            CompositionCode::UnallowedChild => "UNALLOWED_CHILD",
        }
    }
}

impl std::fmt::Display for CompositionCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

fn string_field(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

/// Merges an `allOf` chain into a flat view of properties and requirements.
fn component_def_from_schema(name: &str, schema: &Value) -> ComponentDef {
    let mut props: BTreeMap<String, PropDef> = BTreeMap::new();
    let mut prop_order: Vec<String> = Vec::new();
    let mut required: BTreeSet<String> = BTreeSet::new();
    let mut required_order: Vec<String> = Vec::new();
    let mut description = None;
    let mut allowed_parents = None;
    let mut allowed_children = None;

    let mut stack = vec![schema];
    while let Some(current) = stack.pop() {
        let Some(object) = current.as_object() else {
            continue;
        };
        if description.is_none() {
            description = string_field(object.get("description"));
        }
        if allowed_parents.is_none() {
            allowed_parents = string_list(object.get("allowedParents"));
        }
        if allowed_children.is_none() {
            allowed_children = string_list(object.get("allowedChildren"));
        }
        if let Some(Value::Array(members)) = object.get("allOf") {
            // Reversed so the declared order survives the stack.
            for member in members.iter().rev() {
                stack.push(member);
            }
        }
        if let Some(Value::Array(names)) = object.get("required") {
            for entry in names {
                if let Some(field) = entry.as_str() {
                    if field != "component" && field != "id" && required.insert(field.to_string()) {
                        required_order.push(field.to_string());
                    }
                }
            }
        }
        if let Some(Value::Object(properties)) = object.get("properties") {
            for (prop_name, prop_schema) in properties {
                if prop_name == "component" || prop_name == "id" {
                    continue;
                }
                if !props.contains_key(prop_name) {
                    prop_order.push(prop_name.clone());
                }
                props.insert(
                    prop_name.clone(),
                    PropDef {
                        name: prop_name.clone(),
                        kind: prop_kind_from_schema(prop_schema),
                        value_type: prop_type_from_schema(prop_schema),
                        description: string_field(prop_schema.get("description")),
                        enum_values: string_list(prop_schema.get("enum")).unwrap_or_default(),
                        required: false,
                    },
                );
            }
        }
    }

    for field in &required_order {
        if let Some(prop) = props.get_mut(field) {
            prop.required = true;
        } else {
            // Required but undescribed: keep it so the validator can still
            // demand it.
            prop_order.push(field.clone());
            props.insert(field.clone(), PropDef::new(field, PropKind::Value, true));
        }
    }

    ComponentDef {
        name: name.to_string(),
        description,
        props,
        required: required_order,
        allowed_parents,
        allowed_children,
        prop_order,
    }
}

fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(Value::Array(items)) = value else {
        return None;
    };
    Some(
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    )
}

/// Decides whether a property schema describes a structural link.
fn prop_kind_from_schema(schema: &Value) -> PropKind {
    if let Some(kind) = ref_kind(schema.get("$ref")) {
        return kind;
    }
    // `allOf` / `oneOf` / `anyOf` wrappers around a structural $ref.
    for key in ["allOf", "oneOf", "anyOf"] {
        if let Some(Value::Array(members)) = schema.get(key) {
            for member in members {
                let kind = prop_kind_from_schema(member);
                if kind.is_structural() {
                    return kind;
                }
            }
        }
    }
    if schema.get("type").and_then(Value::as_str) == Some("array") {
        if let Some(items) = schema.get("items") {
            if let Some(kind) = ref_kind(items.get("$ref")) {
                // An array of ComponentId behaves exactly like a static child list.
                return match kind {
                    PropKind::ComponentRef => PropKind::ChildList,
                    other => other,
                };
            }
            if let Some(Value::Object(item_props)) = items.get("properties") {
                let ref_keys: Vec<String> = item_props
                    .iter()
                    .filter(|(_, value)| prop_kind_from_schema(value).is_structural())
                    .map(|(key, _)| key.clone())
                    .collect();
                if !ref_keys.is_empty() {
                    return PropKind::ObjectListRefs { ref_keys };
                }
            }
        }
    }
    PropKind::Value
}

fn ref_kind(reference: Option<&Value>) -> Option<PropKind> {
    let reference = reference?.as_str()?;
    let target = reference.rsplit('/').next()?;
    match target {
        "ComponentId" => Some(PropKind::ComponentRef),
        "ChildList" => Some(PropKind::ChildList),
        _ => None,
    }
}

/// Reads the JSON type a property schema pins its value to.
///
/// Deliberately narrow. A `$ref` is resolved by the *name* of its target rather
/// than by following it, because the common types are a fixed, published set and
/// a catalog is free to reference them across documents this crate never loads.
/// An unrecognized target constrains nothing.
fn prop_type_from_schema(schema: &Value) -> PropType {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        return ref_type(reference);
    }
    if let Some(name) = schema.get("type").and_then(Value::as_str) {
        return PropType::from_schema_name(name);
    }
    // `allOf` members all have to hold, so any one of them that states a type
    // states the type. `oneOf` / `anyOf` members are alternatives, so they only
    // pin a type when every arm agrees — `DynamicString` spelled out inline is
    // `anyOf: [string, DataBinding]`, which pins nothing.
    if let Some(Value::Array(members)) = schema.get("allOf") {
        if let Some(found) = members
            .iter()
            .map(prop_type_from_schema)
            .find(|found| *found != PropType::Unconstrained)
        {
            return found;
        }
    }
    for key in ["oneOf", "anyOf"] {
        let Some(Value::Array(members)) = schema.get(key) else {
            continue;
        };
        let mut arms = members.iter().map(prop_type_from_schema);
        if let Some(first) = arms.next() {
            if first != PropType::Unconstrained && arms.all(|arm| arm == first) {
                return first;
            }
        }
    }
    PropType::Unconstrained
}

/// The JSON type behind a `$ref` to one of the published common types.
fn ref_type(reference: &str) -> PropType {
    match reference.rsplit('/').next().unwrap_or_default() {
        "ComponentId" | "DynamicString" => PropType::String,
        "DynamicNumber" => PropType::Number,
        "DynamicBoolean" => PropType::Boolean,
        "DynamicStringList" => PropType::Array,
        "Action" | "DataBinding" | "AccessibilityAttributes" => PropType::Object,
        // `ChildList` is an array or a template object; `DynamicValue` is
        // anything at all. Neither narrows to one type.
        _ => PropType::Unconstrained,
    }
}

const BASIC_FUNCTION_DEFS: [(&str, &str, &str); 14] = [
    (
        "required",
        "Checks that the value is not null, undefined, or empty.",
        "boolean",
    ),
    (
        "regex",
        "Checks that the value matches a regular expression string.",
        "boolean",
    ),
    ("length", "Checks string length constraints.", "boolean"),
    ("numeric", "Checks numeric range constraints.", "boolean"),
    (
        "email",
        "Checks that the value is a valid email address.",
        "boolean",
    ),
    (
        "formatString",
        "Interpolates data model values and function results into a string.",
        "string",
    ),
    (
        "formatNumber",
        "Formats a number with grouping and precision.",
        "string",
    ),
    (
        "formatCurrency",
        "Formats a number as a currency string.",
        "string",
    ),
    (
        "formatDate",
        "Formats a date/time using a pattern.",
        "string",
    ),
    (
        "pluralize",
        "Selects a localized string based on a numeric count.",
        "string",
    ),
    ("openUrl", "Opens a URL in a browser.", "void"),
    (
        "and",
        "Logical AND over a list of boolean values.",
        "boolean",
    ),
    ("or", "Logical OR over a list of boolean values.", "boolean"),
    ("not", "Logical NOT of a boolean value.", "boolean"),
];

/// The standard catalog's component definitions, transcribed from
/// `basic_catalog.json` of the v0.9 specification.
///
/// Property types come from that document, and
/// `the_built_in_basic_catalog_types_match_the_vendored_specification_document`
/// in this module's tests is what keeps the transcription honest.
fn basic_component_defs() -> Vec<ComponentDef> {
    use PropKind::{ChildList, ComponentRef, ObjectListRefs, Value as Val};
    use PropType::{Array as Arr, Boolean as Bool, Number as Num, Object as Obj, String as Str};

    let align = ["start", "center", "end", "stretch"];
    let justify = [
        "start",
        "center",
        "end",
        "spaceBetween",
        "spaceAround",
        "spaceEvenly",
        "stretch",
    ];
    let checks = || {
        PropDef::new("checks", Val, false)
            .described("Function calls that must return true for this component to be valid.")
    };

    vec![
        ComponentDef::new(
            "Text",
            "Displays text. Supports simple Markdown.",
            vec![
                PropDef::new("text", Val, true)
                    .typed(Str)
                    .described("The text content to display."),
                PropDef::new("variant", Val, false)
                    .typed(Str)
                    .described("A hint for the base text style.")
                    .with_enum(&["h1", "h2", "h3", "h4", "h5", "caption", "body"]),
            ],
        ),
        ComponentDef::new(
            "Image",
            "Displays an image from a URL.",
            vec![
                PropDef::new("url", Val, true)
                    .typed(Str)
                    .described("The image URL."),
                PropDef::new("description", Val, false)
                    .typed(Str)
                    .described("Alternative text describing the image."),
                PropDef::new("fit", Val, false).typed(Str).with_enum(&[
                    "contain",
                    "cover",
                    "fill",
                    "none",
                    "scaleDown",
                ]),
                PropDef::new("variant", Val, false).typed(Str).with_enum(&[
                    "icon",
                    "avatar",
                    "smallFeature",
                    "mediumFeature",
                    "largeFeature",
                    "header",
                ]),
            ],
        ),
        ComponentDef::new(
            "Icon",
            "Displays a system-provided icon from a predefined list.",
            vec![
                PropDef::new("name", Val, true)
                    .described("The icon name, an {svgPath} object, or a data binding.")
                    .with_enum(&BASIC_ICON_NAMES),
            ],
        ),
        ComponentDef::new(
            "Video",
            "Displays a video from a URL.",
            vec![
                PropDef::new("url", Val, true)
                    .typed(Str)
                    .described("The video URL."),
            ],
        ),
        ComponentDef::new(
            "AudioPlayer",
            "A player for audio content from a URL.",
            vec![
                PropDef::new("url", Val, true)
                    .typed(Str)
                    .described("The audio URL."),
                PropDef::new("description", Val, false)
                    .typed(Str)
                    .described("Text describing the audio content."),
            ],
        ),
        ComponentDef::new(
            "Row",
            "A layout container that arranges its children horizontally.",
            vec![
                PropDef::new("children", ChildList, true),
                PropDef::new("justify", Val, false)
                    .typed(Str)
                    .described("Arrangement along the main (horizontal) axis.")
                    .with_enum(&justify),
                PropDef::new("align", Val, false)
                    .typed(Str)
                    .described("Alignment along the cross (vertical) axis.")
                    .with_enum(&align),
            ],
        ),
        ComponentDef::new(
            "Column",
            "A layout container that arranges its children vertically.",
            vec![
                PropDef::new("children", ChildList, true),
                PropDef::new("justify", Val, false)
                    .typed(Str)
                    .with_enum(&justify),
                PropDef::new("align", Val, false)
                    .typed(Str)
                    .with_enum(&align),
            ],
        ),
        ComponentDef::new(
            "List",
            "A scrollable list of components.",
            vec![
                PropDef::new("children", ChildList, true),
                PropDef::new("direction", Val, false)
                    .typed(Str)
                    .with_enum(&["vertical", "horizontal"]),
                PropDef::new("align", Val, false)
                    .typed(Str)
                    .with_enum(&align),
            ],
        ),
        ComponentDef::new(
            "Card",
            "A container with card-like styling.",
            vec![
                PropDef::new("child", ComponentRef, true)
                    .typed(Str)
                    .described(
                        "The single child to render inside the card. Wrap multiple elements in a \
                 Row or Column and pass that container's id.",
                    ),
            ],
        ),
        ComponentDef::new(
            "Tabs",
            "A set of tabs, each with a title and a child component.",
            vec![
                PropDef::new(
                    "tabs",
                    ObjectListRefs {
                        ref_keys: vec!["child".to_string()],
                    },
                    true,
                )
                .typed(Arr)
                .described("Array of {title, child} objects."),
            ],
        ),
        ComponentDef::new(
            "Divider",
            "A horizontal or vertical dividing line.",
            vec![
                PropDef::new("axis", Val, false)
                    .typed(Str)
                    .with_enum(&["horizontal", "vertical"]),
            ],
        ),
        ComponentDef::new(
            "Modal",
            "A dialog shown over the main content, opened by a trigger component.",
            vec![
                PropDef::new("trigger", ComponentRef, true)
                    .typed(Str)
                    .described("The component that opens the modal."),
                PropDef::new("content", ComponentRef, true)
                    .typed(Str)
                    .described("The component shown inside the modal."),
            ],
        ),
        ComponentDef::new(
            "Button",
            "A clickable button that dispatches an action.",
            vec![
                PropDef::new("child", ComponentRef, true)
                    .typed(Str)
                    .described("The button's label component, usually a Text."),
                PropDef::new("action", Val, true)
                    .typed(Obj)
                    .described("An {event} sent to the agent, or a local {functionCall}."),
                PropDef::new("variant", Val, false).typed(Str).with_enum(&[
                    "default",
                    "primary",
                    "borderless",
                ]),
                checks(),
            ],
        ),
        ComponentDef::new(
            "CheckBox",
            "A checkbox with a label and a boolean value.",
            vec![
                PropDef::new("label", Val, true).typed(Str),
                PropDef::new("value", Val, true)
                    .typed(Bool)
                    .described("Two-way bound boolean, usually {\"path\": ...}."),
                checks(),
            ],
        ),
        ComponentDef::new(
            "TextField",
            "A field for user text input.",
            vec![
                PropDef::new("label", Val, true).typed(Str),
                PropDef::new("value", Val, false)
                    .typed(Str)
                    .described("Two-way bound string, usually {\"path\": ...}."),
                PropDef::new("variant", Val, false).typed(Str).with_enum(&[
                    "shortText",
                    "longText",
                    "number",
                    "obscured",
                ]),
                PropDef::new("validationRegexp", Val, false).typed(Str),
                checks(),
            ],
        ),
        ComponentDef::new(
            "DateTimeInput",
            "An input for a date and/or a time.",
            vec![
                PropDef::new("value", Val, true)
                    .typed(Str)
                    .described("ISO 8601 value, two-way bound."),
                PropDef::new("label", Val, false).typed(Str),
                PropDef::new("enableDate", Val, false).typed(Bool),
                PropDef::new("enableTime", Val, false).typed(Bool),
                // ISO 8601 bounds. The specification narrows the format further
                // (`date`, `time` or `date-time`); this crate checks the type
                // only, which is the part a generating model gets wrong.
                PropDef::new("min", Val, false).typed(Str),
                PropDef::new("max", Val, false).typed(Str),
                checks(),
            ],
        ),
        ComponentDef::new(
            "ChoicePicker",
            "Selects one or more options from a list.",
            vec![
                PropDef::new("options", Val, true)
                    .typed(Arr)
                    .described("Array of {label, value} options."),
                PropDef::new("value", Val, true)
                    .typed(Arr)
                    .described("Selected values as a string array, two-way bound."),
                PropDef::new("label", Val, false).typed(Str),
                PropDef::new("variant", Val, false)
                    .typed(Str)
                    .with_enum(&["mutuallyExclusive", "multipleSelection"]),
                PropDef::new("displayStyle", Val, false)
                    .typed(Str)
                    .with_enum(&["checkbox", "chips"]),
                PropDef::new("filterable", Val, false).typed(Bool),
                checks(),
            ],
        ),
        ComponentDef::new(
            "Slider",
            "A slider for selecting a numeric value within a range.",
            vec![
                PropDef::new("value", Val, true)
                    .typed(Num)
                    .described("Two-way bound number."),
                PropDef::new("max", Val, true).typed(Num),
                PropDef::new("min", Val, false).typed(Num),
                PropDef::new("label", Val, false).typed(Str),
                checks(),
            ],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn basic_catalog_has_the_eighteen_components_and_fourteen_functions() {
        let catalog = Catalog::basic();
        assert_eq!(catalog.components.len(), 18);
        assert_eq!(catalog.functions.len(), 14);
        for name in BASIC_COMPONENTS {
            assert!(catalog.has_component(name), "missing {name}");
        }
        let order: Vec<&str> = catalog
            .components_in_order()
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(order, BASIC_COMPONENTS.to_vec());
    }

    #[test]
    fn structural_props_are_marked_and_value_props_are_not() {
        let catalog = Catalog::basic();
        assert_eq!(
            catalog.component("Card").unwrap().props["child"].kind,
            PropKind::ComponentRef
        );
        assert_eq!(
            catalog.component("Row").unwrap().props["children"].kind,
            PropKind::ChildList
        );
        assert_eq!(
            catalog.component("Text").unwrap().props["text"].kind,
            PropKind::Value
        );
        // An Image url is a string but never a component reference.
        assert!(
            !catalog.component("Image").unwrap().props["url"]
                .kind
                .is_structural()
        );
    }

    #[test]
    fn references_cover_ids_lists_templates_and_nested_objects() {
        let catalog = Catalog::basic();

        let card = Component::new("c", "Card").with("child", json!("inner"));
        assert_eq!(
            catalog.references(&card),
            vec![ComponentRef {
                location: "child".into(),
                id: "inner".into()
            }]
        );

        let row = Component::new("r", "Row").with("children", json!(["a", "b"]));
        let ids: Vec<String> = catalog.references(&row).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);

        let list = Component::new("l", "List")
            .with("children", json!({"componentId": "tpl", "path": "/items"}));
        assert_eq!(
            catalog.references(&list),
            vec![ComponentRef {
                location: "children.componentId".into(),
                id: "tpl".into()
            }]
        );

        let tabs = Component::new("t", "Tabs").with(
            "tabs",
            json!([{"title": "One", "child": "p1"}, {"title": "Two", "child": "p2"}]),
        );
        let locations: Vec<String> = catalog
            .references(&tabs)
            .into_iter()
            .map(|r| r.location)
            .collect();
        assert_eq!(
            locations,
            vec!["tabs[0].child".to_string(), "tabs[1].child".to_string()]
        );
    }

    #[test]
    fn unknown_component_types_yield_no_references() {
        let catalog = Catalog::basic();
        let mystery = Component::new("m", "Sparkline").with("child", json!("x"));
        assert!(catalog.references(&mystery).is_empty());
    }

    #[test]
    fn from_schema_merges_all_of_and_detects_ref_kinds() {
        let schema = json!({
            "catalogId": "test",
            "components": {
                "Panel": {
                    "type": "object",
                    "allOf": [
                        {"$ref": "common_types.json#/$defs/ComponentCommon"},
                        {
                            "type": "object",
                            "properties": {
                                "component": {"const": "Panel"},
                                "children": {"$ref": "common_types.json#/$defs/ChildList"},
                                "header": {"$ref": "common_types.json#/$defs/ComponentId"},
                                "title": {"type": "string"}
                            },
                            "required": ["component", "children"]
                        }
                    ]
                }
            },
            "functions": {"now": {"returnType": "string"}}
        });
        let catalog = Catalog::from_schema(&schema).unwrap();
        let panel = catalog.component("Panel").unwrap();
        assert_eq!(panel.props["children"].kind, PropKind::ChildList);
        assert_eq!(panel.props["header"].kind, PropKind::ComponentRef);
        assert_eq!(panel.props["title"].kind, PropKind::Value);
        assert_eq!(panel.required, vec!["children"]);
        assert_eq!(
            catalog.functions["now"].return_type.as_deref(),
            Some("string")
        );
    }

    #[test]
    fn from_schema_reads_the_type_each_property_declares() {
        let schema = json!({
            "catalogId": "test",
            "components": {
                "Chart": {
                    "type": "object",
                    "allOf": [
                        {
                            "type": "object",
                            "properties": {
                                "columns": {"type": "integer"},
                                "ratio": {"type": "number"},
                                "stacked": {"type": "boolean"},
                                "series": {"type": "array"},
                                "legend": {"type": "object"}
                            }
                        },
                        {
                            "type": "object",
                            "properties": {
                                "title": {"$ref": "common_types.json#/$defs/DynamicString"},
                                "caption": {"anyOf": [{"type": "string"}, {"type": "number"}]},
                                "anything": {"description": "no type at all"}
                            }
                        }
                    ]
                }
            }
        });
        let catalog = Catalog::from_schema(&schema).unwrap();
        let chart = catalog.component("Chart").unwrap();
        let type_of = |name: &str| chart.props[name].value_type;
        assert_eq!(type_of("columns"), PropType::Integer);
        assert_eq!(type_of("ratio"), PropType::Number);
        assert_eq!(type_of("stacked"), PropType::Boolean);
        assert_eq!(type_of("series"), PropType::Array);
        assert_eq!(type_of("legend"), PropType::Object);
        // A `Dynamic*` reference is its underlying type; a binding in its place
        // is skipped by the validator rather than described here.
        assert_eq!(type_of("title"), PropType::String);
        // Alternatives that disagree, and a schema with no type at all, pin
        // nothing rather than guessing.
        assert_eq!(type_of("caption"), PropType::Unconstrained);
        assert_eq!(type_of("anything"), PropType::Unconstrained);
    }

    #[test]
    fn the_built_in_basic_catalog_types_match_the_vendored_specification_document() {
        // `Catalog::basic()` is hand-transcribed so it costs no parsing at
        // startup. This is what keeps the transcription honest: the vendored
        // v0.9 `basic_catalog.json` is the source it was copied from, so parsing
        // that document has to produce the same types.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/spec_v0_9/basic_catalog.json");
        let document: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
            .expect("the vendored basic catalog is JSON");
        let parsed = Catalog::from_schema(&document).unwrap();
        let built_in = Catalog::basic();

        let mut compared = 0;
        for def in built_in.components_in_order() {
            let from_spec = parsed
                .component(&def.name)
                .unwrap_or_else(|| panic!("the specification catalog has no '{}'", def.name));
            for prop in def.props_in_order() {
                // `checks` is declared per input component here but is not in
                // the specification document; nothing to compare it against.
                let Some(spec_prop) = from_spec.props.get(&prop.name) else {
                    continue;
                };
                assert_eq!(
                    prop.value_type, spec_prop.value_type,
                    "{}.{} is {:?} here and {:?} in the specification",
                    def.name, prop.name, prop.value_type, spec_prop.value_type
                );
                compared += 1;
            }
        }
        assert!(compared > 40, "only {compared} properties were compared");
    }

    #[test]
    fn from_schema_treats_bare_strings_as_data_not_links() {
        // Per spec: a raw string type is static text, so its target is never checked.
        let schema = json!({
            "catalogId": "loose",
            "components": {
                "Card": {"type": "object", "properties": {"child": {"type": "string"}}}
            }
        });
        let catalog = Catalog::from_schema(&schema).unwrap();
        assert_eq!(
            catalog.component("Card").unwrap().props["child"].kind,
            PropKind::Value
        );
        let card = Component::new("root", "Card").with("child", json!("missing"));
        assert!(catalog.references(&card).is_empty());
    }

    #[test]
    fn from_schema_requires_a_catalog_id() {
        assert!(Catalog::from_schema(&json!({"components": {}})).is_err());
        assert!(Catalog::from_schema(&json!("nope")).is_err());
    }

    #[test]
    fn composition_constraints_flag_bad_parents_and_children() {
        let schema = json!({
            "catalogId": "menu",
            "components": {
                "AppLayout": {
                    "type": "object",
                    "allowedParents": ["Surface"],
                    "properties": {"child": {"$ref": "#/$defs/ComponentId"}}
                },
                "Menu": {
                    "type": "object",
                    "allowedChildren": ["MenuItem"],
                    "properties": {"children": {"$ref": "#/$defs/ChildList"}}
                },
                "MenuItem": {"type": "object", "allowedParents": ["Menu"]},
                "Text": {"type": "object"}
            }
        });
        let catalog = Catalog::from_schema(&schema).unwrap();

        let good = vec![
            Component::new(ROOT_ID, "AppLayout").with("child", json!("m")),
            Component::new("m", "Menu").with("children", json!(["i"])),
            Component::new("i", "MenuItem"),
        ];
        assert!(catalog.composition_violations(&good).is_empty());

        let bad = vec![
            Component::new(ROOT_ID, "Menu").with("children", json!(["t"])),
            Component::new("t", "Text"),
        ];
        let violations = catalog.composition_violations(&bad);
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].code, CompositionCode::UnallowedChild);
        assert_eq!(violations[0].path, "components[0].children[0]");

        let misplaced = vec![
            Component::new(ROOT_ID, "Menu").with("children", json!(["a"])),
            Component::new("a", "AppLayout"),
        ];
        let violations = catalog.composition_violations(&misplaced);
        assert!(
            violations
                .iter()
                .any(|v| v.code == CompositionCode::UnallowedParent)
        );
    }

    #[test]
    fn root_must_satisfy_its_own_allowed_parents() {
        let schema = json!({
            "catalogId": "menu",
            "components": {"MenuItem": {"type": "object", "allowedParents": ["Menu"]}}
        });
        let catalog = Catalog::from_schema(&schema).unwrap();
        let violations = catalog.composition_violations(&[Component::new(ROOT_ID, "MenuItem")]);
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].code, CompositionCode::UnallowedParent);
        assert_eq!(violations[0].path, "components[0].component");
    }

    #[test]
    fn basic_catalog_declares_no_composition_constraints() {
        let catalog = Catalog::basic();
        let components = vec![
            Component::new(ROOT_ID, "Card").with("child", json!("t")),
            Component::new("t", "Text").with("text", json!("hi")),
        ];
        assert!(catalog.composition_violations(&components).is_empty());
    }

    #[test]
    fn the_summary_mentions_every_component() {
        let rendered = Catalog::basic().render_summary();
        for name in BASIC_COMPONENTS {
            assert!(rendered.contains(name), "instructions omit {name}");
        }
        assert!(rendered.contains("children (component ids or {componentId, path})"));
    }
}
