//! Semantic validation of a component tree.
//!
//! JSON Schema can say that `children` is an array of strings. It cannot say
//! that every one of those strings names a component that exists, that the tree
//! has a root, or that `a → b → a` is a loop the renderer will never finish
//! drawing. That is what this module checks.
//!
//! Every failure is a [`ValidationError`] carrying a machine-readable
//! [`ErrorCode`], a `path` locator into the components list, and a sentence
//! written to be fed straight back to a model on retry. The validator collects
//! *all* errors rather than stopping at the first, so one retry can fix
//! everything at once.
//!
//! # Depth
//!
//! The component graph is walked iteratively, with an explicit worklist, in
//! every case — cycle detection, reachability, and scope assignment. That is not
//! a style preference: the graph is model-generated and its depth is bounded by
//! nothing, so a recursive walk would abort the process rather than fail a
//! request. [`MAX_DEPTH`] is therefore a *policy* about what a renderer will
//! draw, not what keeps this crate standing, and it can be raised safely.
//!
//! # Full surfaces and incremental updates
//!
//! A payload that creates a surface is held to the full contract: a `root` must
//! exist and every child reference must resolve within the payload. An
//! incremental `updateComponents` is not — its components may legitimately
//! reference ids the renderer already holds, and it need not include the root.
//! [`ValidateOptions::incremental_update`] relaxes exactly those two rules;
//! duplicate ids and cycles still fail, because those are broken either way.
//!
//! ```
//! use ag_ui_a2ui::{catalog::Catalog, message::Component, validate::{ErrorCode, Validator}};
//! use serde_json::json;
//!
//! let catalog = Catalog::basic();
//! let report = Validator::new(&catalog).validate(&[
//!     Component::new("root", "Card").with("child", json!("nope")),
//! ]);
//! assert_eq!(report.errors[0].code, ErrorCode::UnresolvedChild);
//! assert_eq!(report.errors[0].path, "components[0].child");
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::binding::{Scope, collect_bindings};
use crate::catalog::{Catalog, ComponentDef, PropType};
use crate::constants::{PROTOCOL_VERSION, ROOT_ID};
use crate::error::{Error, Result, ValidationErrors};
use crate::message::{AgentMessage, Component};

/// Deepest nesting accepted by default, for both the component graph and the
/// raw JSON of a message.
///
/// Matches the limit every other A2UI toolkit enforces, so a payload one of them
/// accepts is accepted here and vice versa. Nothing in this crate needs the cap
/// to stay safe — every walk is iterative — but a renderer that recurses does,
/// and the input is model-generated.
pub const MAX_DEPTH: usize = 50;

/// Deepest chain of nested function calls accepted by default.
pub const MAX_FUNCTION_CALL_DEPTH: usize = 5;

/// The complete set of semantic failures this validator reports.
///
/// Deliberately closed: these codes are the contract with callers that route on
/// them (a recovery loop, a renderer's error channel), so adding one is a
/// breaking change. Composition-constraint failures have their own codes and
/// live in [`crate::catalog::CompositionCode`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ErrorCode {
    /// The payload declares a surface but carries no components.
    EmptyComponents,
    /// A component has no usable `id`.
    MissingId,
    /// A component has no usable `component` type name.
    MissingComponentType,
    /// Two components share an `id`.
    DuplicateId,
    /// No component has the root id, so the renderer has nothing to draw from.
    NoRoot,
    /// A component's type is not defined by the surface's catalog.
    UnknownComponent,
    /// A property the catalog marks required is missing.
    MissingRequiredProp,
    /// A field the protocol requires on a message envelope is missing.
    ///
    /// Distinct from [`ErrorCode::MissingRequiredProp`], which is about a
    /// component property a *catalog* declares: this one is fixed by the wire
    /// format and holds whatever catalog is in play.
    MissingField,
    /// A value has the right shape but is not one the protocol permits, such as
    /// a `version` naming a protocol revision this crate does not speak.
    InvalidValue,
    /// A value is of the wrong JSON type — `"3"` where a number is required, or
    /// a number where the catalog declares a string.
    TypeMismatch,
    /// A child reference names a component id that does not exist.
    UnresolvedChild,
    /// Following child references leads back to where it started.
    ChildCycle,
    /// A data binding cannot resolve against the surface's data model.
    UnresolvedBinding,
    /// Nesting runs deeper than the configured maximum.
    ///
    /// Distinct from [`ErrorCode::ChildCycle`]: a deep tree is finite and
    /// acyclic, it is just deeper than anything a renderer will draw, and deep
    /// enough to threaten a recursive consumer. Covers three kinds of nesting —
    /// the component graph, the raw JSON, and chained function calls — because
    /// all three are model-generated and all three are unbounded without a cap.
    MaxDepthExceeded,
}

impl ErrorCode {
    /// The wire string for this code.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::EmptyComponents => "empty_components",
            ErrorCode::MissingId => "missing_id",
            ErrorCode::MissingComponentType => "missing_component_type",
            ErrorCode::DuplicateId => "duplicate_id",
            ErrorCode::NoRoot => "no_root",
            ErrorCode::UnknownComponent => "unknown_component",
            ErrorCode::MissingRequiredProp => "missing_required_prop",
            // These three are spelled the way the conformance suite spells
            // them, so a caller routing on codes sees the same strings from
            // every A2UI toolkit.
            ErrorCode::MissingField => "missing_field",
            ErrorCode::InvalidValue => "invalid_value",
            ErrorCode::TypeMismatch => "type_mismatch",
            ErrorCode::UnresolvedChild => "unresolved_child",
            ErrorCode::ChildCycle => "child_cycle",
            ErrorCode::UnresolvedBinding => "unresolved_binding",
            ErrorCode::MaxDepthExceeded => "max_depth_exceeded",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One semantic failure, located and explained.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationError {
    /// What kind of failure this is.
    pub code: ErrorCode,
    /// Where it is, e.g. `components[2].component` or `components[0].children[1]`.
    pub path: String,
    /// A sentence a human or a model can act on.
    pub message: String,
}

impl ValidationError {
    /// Builds an error.
    pub fn new(code: ErrorCode, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}: {}", self.code, self.path, self.message)
    }
}

/// What the validator should demand of a payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidateOptions {
    /// Id the tree root must have. Defaults to [`ROOT_ID`].
    pub root_id: String,
    /// Whether a component with the root id must be present.
    pub require_root: bool,
    /// Whether child references may point outside this payload.
    pub allow_dangling_children: bool,
    /// Whether component types must exist in the catalog.
    ///
    /// Turned off automatically when the catalog defines no components at all,
    /// since that means the caller has not supplied one.
    pub check_component_types: bool,
    /// Whether required properties are enforced.
    pub check_required_props: bool,
    /// Whether property values must match the JSON type the catalog declares.
    ///
    /// Only properties the catalog pins to one type are checked, and a value the
    /// renderer resolves — a `{"path": …}` binding or a function call — is never
    /// checked, because its type on the wire says nothing about the type it
    /// will have. See [`PropType`].
    pub check_prop_types: bool,
    /// Whether message envelopes must satisfy the v0.9 wire contract.
    ///
    /// Applies only to the raw-message entry points
    /// ([`Validator::validate_json_messages`] and
    /// [`Validator::validate_messages`]); the component entry points are handed
    /// components directly and have no envelope to check.
    pub check_envelope: bool,
    /// Whether data bindings are resolved against the data model, and whether
    /// relative paths are required to sit inside a list template.
    pub check_bindings: bool,
    /// Whether absolute binding paths must be syntactically valid JSON Pointers.
    ///
    /// Separate from [`ValidateOptions::check_bindings`] because it needs no
    /// data model and cannot produce a false positive: a malformed escape can
    /// never resolve, whatever the data turns out to be.
    pub check_binding_syntax: bool,
    /// Deepest nesting accepted, for both the component graph and the raw JSON.
    ///
    /// Defaults to [`MAX_DEPTH`]. Raising it is safe here — every walk in this
    /// crate is iterative — but a renderer on the other end may not be, and a
    /// tree this deep is a generation failure rather than a design.
    pub max_depth: usize,
    /// Deepest chain of function calls accepted, counting nesting through `args`.
    ///
    /// Defaults to [`MAX_FUNCTION_CALL_DEPTH`].
    pub max_function_call_depth: usize,
}

impl Default for ValidateOptions {
    fn default() -> Self {
        Self::full_surface()
    }
}

impl ValidateOptions {
    /// The full contract, for a payload that creates a surface.
    pub fn full_surface() -> Self {
        Self {
            root_id: ROOT_ID.to_string(),
            require_root: true,
            allow_dangling_children: false,
            check_component_types: true,
            check_required_props: true,
            check_prop_types: true,
            check_envelope: true,
            check_bindings: true,
            check_binding_syntax: true,
            max_depth: MAX_DEPTH,
            max_function_call_depth: MAX_FUNCTION_CALL_DEPTH,
        }
    }

    /// The relaxed contract, for a payload that updates an existing surface.
    ///
    /// The root and the referenced components may already live on the renderer,
    /// so their absence from this payload is not an error.
    pub fn incremental_update() -> Self {
        Self {
            require_root: false,
            allow_dangling_children: true,
            ..Self::full_surface()
        }
    }

    /// Overrides the root component id.
    #[must_use]
    pub fn with_root_id(mut self, root_id: impl Into<String>) -> Self {
        self.root_id = root_id.into();
        self
    }

    /// Overrides the maximum nesting depth.
    #[must_use]
    pub fn with_max_depth(mut self, max_depth: usize) -> Self {
        self.max_depth = max_depth;
        self
    }
}

/// What a validation run found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ValidationReport {
    /// Failures, in discovery order.
    pub errors: Vec<ValidationError>,
    /// Ids that exist but cannot be reached from the root.
    ///
    /// Not an error: the specification tells renderers to buffer components
    /// until their parent shows up, so an unreachable component is usually a
    /// half-streamed tree rather than a broken one. It is still worth telling a
    /// generating model about, so it is reported separately.
    pub unreachable: Vec<String>,
}

impl ValidationReport {
    /// Whether the payload is free of errors.
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty()
    }

    /// Turns the report into a `Result`, discarding warnings.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Validation`] when any error was reported.
    pub fn into_result(self) -> Result<()> {
        if self.errors.is_empty() {
            Ok(())
        } else {
            Err(Error::Validation {
                errors: ValidationErrors(self.errors),
            })
        }
    }

    /// The errors as a [`ValidationErrors`] list, for prompting or reporting.
    pub fn errors(&self) -> ValidationErrors {
        ValidationErrors(self.errors.clone())
    }
}

/// Validates component trees against a catalog.
#[derive(Clone, Debug)]
pub struct Validator<'a> {
    catalog: &'a Catalog,
    options: ValidateOptions,
}

/// A component normalized for validation, from either typed or raw JSON input.
struct Node<'a> {
    index: usize,
    id: Option<&'a str>,
    kind: Option<&'a str>,
    props: Option<&'a Map<String, Value>>,
    /// Set when the caller handed us typed components.
    borrowed: Option<&'a Component>,
    /// Set when we rebuilt a typed component from raw JSON.
    owned: Option<Component>,
}

impl<'a> Node<'a> {
    fn from_component(index: usize, component: &'a Component) -> Self {
        Self {
            index,
            id: (!component.id.is_empty()).then_some(component.id.as_str()),
            kind: (!component.component.is_empty()).then_some(component.component.as_str()),
            props: Some(&component.props),
            borrowed: Some(component),
            owned: None,
        }
    }

    fn from_json(index: usize, value: &'a Value) -> Self {
        let object = value.as_object();
        let id = object
            .and_then(|o| o.get("id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let kind = object
            .and_then(|o| o.get("component"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        // Rebuild a typed component so catalog reference extraction works on
        // raw LLM output too.
        let owned = match (id, kind) {
            (Some(id), Some(kind)) => {
                let mut props = object.cloned().unwrap_or_default();
                props.remove("id");
                props.remove("component");
                Some(Component {
                    id: id.to_string(),
                    component: kind.to_string(),
                    props,
                })
            }
            _ => None,
        };
        Self {
            index,
            id,
            kind,
            props: object,
            borrowed: None,
            owned,
        }
    }

    fn component(&self) -> Option<&Component> {
        self.borrowed.or(self.owned.as_ref())
    }

    fn locator(&self, suffix: &str) -> String {
        if suffix.is_empty() {
            format!("components[{}]", self.index)
        } else {
            format!("components[{}].{suffix}", self.index)
        }
    }
}

impl<'a> Validator<'a> {
    /// A validator holding a payload to the full-surface contract.
    pub fn new(catalog: &'a Catalog) -> Self {
        Self {
            catalog,
            options: ValidateOptions::full_surface(),
        }
    }

    /// A validator for an incremental `updateComponents` payload.
    pub fn incremental(catalog: &'a Catalog) -> Self {
        Self {
            catalog,
            options: ValidateOptions::incremental_update(),
        }
    }

    /// A validator with explicit options.
    pub fn with_options(catalog: &'a Catalog, options: ValidateOptions) -> Self {
        Self { catalog, options }
    }

    /// Validates typed components, with no data model to bind against.
    pub fn validate(&self, components: &[Component]) -> ValidationReport {
        self.validate_surface(components, None)
    }

    /// Validates typed components against a surface data model.
    pub fn validate_surface(
        &self,
        components: &[Component],
        data_model: Option<&Value>,
    ) -> ValidationReport {
        let nodes: Vec<Node<'_>> = components
            .iter()
            .enumerate()
            .map(|(i, c)| Node::from_component(i, c))
            .collect();
        self.run(&nodes, components, data_model)
    }

    /// Validates graph and bindings against a lossless model, including every
    /// defined item of a template collection and undefined array slots.
    pub fn validate_model(
        &self,
        components: &[Component],
        model: &crate::DataModel,
    ) -> ValidationReport {
        let mut report = self.validate_surface(components, None);
        if !self.options.check_bindings
            || report
                .errors
                .iter()
                .any(|e| e.code == ErrorCode::ChildCycle)
        {
            return report;
        }
        let by_id: BTreeMap<_, _> = components.iter().map(|c| (c.id.as_str(), c)).collect();
        let mut queue = vec![(
            self.options.root_id.clone(),
            crate::binding::ModelScope::root(model),
        )];
        let mut visited = BTreeSet::new();
        while let Some((id, scope)) = queue.pop() {
            if !visited.insert((id.clone(), scope.absolute(""))) {
                continue;
            }
            let Some(component) = by_id.get(id.as_str()) else {
                continue;
            };
            let raw = serde_json::to_value(component).expect("component JSON is infallible");
            for binding in collect_bindings(&raw) {
                let resolved = scope.resolve(&binding.path);
                let valid = match &resolved {
                    Ok(Some(crate::ModelValue::Array(_))) => true,
                    Ok(Some(_)) => !binding.is_collection,
                    _ => false,
                };
                if !valid {
                    report.errors.push(ValidationError::new(
                        ErrorCode::UnresolvedBinding,
                        format!("components[{id}].{}", binding.location),
                        format!(
                            "Binding {:?} is missing, undefined, or not a collection.",
                            binding.path
                        ),
                    ));
                }
            }
            for reference in self.catalog.references(component) {
                if let Some(path) = template_path(component, &reference.location) {
                    if let Ok(Some(crate::ModelValue::Array(items))) = scope.resolve(&path) {
                        for (index, item) in items.iter().enumerate() {
                            if !matches!(item, crate::ModelValue::Undefined) {
                                queue.push((reference.id.clone(), scope.item(&path, index)));
                            }
                        }
                    }
                } else {
                    queue.push((reference.id, scope.clone()));
                }
            }
        }
        report
    }

    /// Validates raw JSON components, as they arrive from a model.
    ///
    /// Unlike the typed entry points this can report [`ErrorCode::MissingId`]
    /// and [`ErrorCode::MissingComponentType`], because raw objects are free to
    /// omit them.
    pub fn validate_json(
        &self,
        components: &[Value],
        data_model: Option<&Value>,
    ) -> ValidationReport {
        let nodes: Vec<Node<'_>> = components
            .iter()
            .enumerate()
            .map(|(i, v)| Node::from_json(i, v))
            .collect();
        let typed: Vec<Component> = nodes
            .iter()
            .filter_map(|n| n.component().cloned())
            .collect();
        self.run(&nodes, &typed, data_model)
    }

    /// Validates a whole operation stream.
    ///
    /// Replays messages separately per surface, then validates complete trees.
    /// Updates require creation within this stream. Use `validate_updates`
    /// with explicit prior state for a partial stream.
    pub fn validate_messages(&self, messages: &[AgentMessage]) -> ValidationReport {
        match messages
            .iter()
            .map(serde_json::to_value)
            .collect::<std::result::Result<Vec<_>, _>>()
        {
            Ok(raw) => self.validate_json_messages(&raw),
            Err(error) => ValidationReport {
                errors: vec![ValidationError::new(
                    ErrorCode::InvalidValue,
                    "messages",
                    error.to_string(),
                )],
                ..Default::default()
            },
        }
    }

    /// Validates raw protocol messages, as they arrive on the wire.
    ///
    /// The same folding as [`Validator::validate_messages`], plus the checks
    /// that only make sense on the raw JSON: the message envelope, how deeply
    /// the message nests, and how long a chain of function calls it carries.
    /// None of the three survives deserialization into typed messages, because
    /// all three are properties of the document rather than of any one
    /// component.
    pub fn validate_json_messages(&self, messages: &[Value]) -> ValidationReport {
        let mut message_report = ValidationReport::default();
        for (index, message) in messages.iter().enumerate() {
            let locator = format!("messages[{index}]");
            if self.options.check_envelope {
                check_envelope(message, &locator, &mut message_report);
            }
            check_value_depth(
                message,
                &locator,
                // The enclosing array is depth 0, so a message sits at 1.
                1,
                self.options.max_depth,
                self.options.max_function_call_depth,
                &mut message_report,
            );
        }

        if !message_report.errors.is_empty() {
            return message_report;
        }
        let mut store = crate::surface::SurfaceStore::new();
        for (index, message) in messages.iter().enumerate() {
            // Preserve raw component diagnostics before serde can normalize fields.
            if let Some(Value::Array(components)) = message.pointer("/updateComponents/components")
            {
                let mut options = self.options.clone();
                options.require_root = false;
                options.allow_dangling_children = true;
                options.check_bindings = false;
                let report =
                    Validator::with_options(self.catalog, options).validate_json(components, None);
                message_report.errors.extend(report.errors);
            }
            match serde_json::from_value::<AgentMessage>(message.clone()) {
                Ok(op) => {
                    if let Err(error) = store.apply(&op) {
                        message_report.errors.push(ValidationError::new(
                            ErrorCode::InvalidValue,
                            format!("messages[{index}]"),
                            error.to_string(),
                        ));
                    }
                }
                Err(error) => message_report.errors.push(ValidationError::new(
                    ErrorCode::InvalidValue,
                    format!("messages[{index}]"),
                    error.to_string(),
                )),
            }
        }
        for surface in store.surfaces().filter(|surface| !surface.deleted) {
            let report = self.validate_model(&surface.components, &surface.data_model);
            message_report.errors.extend(report.errors);
            message_report.unreachable.extend(report.unreachable);
        }
        message_report
    }

    /// Validates updates against explicit previously observed renderer state.
    /// The caller receives a candidate store only when every message succeeds.
    pub fn validate_updates(
        &self,
        prior: &crate::surface::SurfaceStore,
        messages: &[AgentMessage],
    ) -> Result<crate::surface::SurfaceStore> {
        let mut next = prior.clone();
        for message in messages {
            let raw = serde_json::to_value(message)?;
            let mut report = ValidationReport::default();
            check_envelope(&raw, "message", &mut report);
            report.into_result()?;
            next.apply(message)?;
        }
        for surface in next.surfaces().filter(|s| !s.deleted) {
            self.validate_model(&surface.components, &surface.data_model)
                .into_result()?;
        }
        Ok(next)
    }

    fn run(
        &self,
        nodes: &[Node<'_>],
        typed: &[Component],
        data_model: Option<&Value>,
    ) -> ValidationReport {
        let mut report = ValidationReport::default();

        if nodes.is_empty() {
            report.errors.push(ValidationError::new(
                ErrorCode::EmptyComponents,
                "components",
                "The components list is empty. A surface needs at least a component with \
                 id 'root'.",
            ));
            return report;
        }

        let ids = self.check_identity(nodes, &mut report);
        self.check_types_and_props(nodes, &mut report);
        self.check_component_depth(nodes, &mut report);

        if self.options.require_root && !ids.contains_key(self.options.root_id.as_str()) {
            report.errors.push(ValidationError::new(
                ErrorCode::NoRoot,
                "components",
                format!(
                    "No component has id '{}'. Exactly one component must use that id; it is \
                     the root the renderer draws from.",
                    self.options.root_id
                ),
            ));
        }

        let adjacency = self.build_adjacency(nodes, &ids, &mut report);
        self.check_cycles(nodes, &adjacency, &mut report);

        let reachable = reachable_from_root(&ids, &adjacency, &self.options.root_id);
        if let Some(reachable) = &reachable {
            for node in nodes {
                if let Some(id) = node.id {
                    if !reachable.contains(&node.index) {
                        report.unreachable.push(id.to_string());
                    }
                }
            }
        }

        if self.options.check_bindings || self.options.check_binding_syntax {
            self.check_bindings(nodes, typed, &ids, &adjacency, data_model, &mut report);
        }
        report
    }

    /// Ids, types and duplicates. Returns id → node index for resolved ids.
    fn check_identity<'n>(
        &self,
        nodes: &'n [Node<'n>],
        report: &mut ValidationReport,
    ) -> BTreeMap<&'n str, usize> {
        let mut ids: BTreeMap<&str, usize> = BTreeMap::new();
        for node in nodes {
            let Some(id) = node.id else {
                report.errors.push(ValidationError::new(
                    ErrorCode::MissingId,
                    node.locator("id"),
                    "Every component needs a non-empty string 'id'; other components reference \
                     it by that id.",
                ));
                continue;
            };
            if let Some(first) = ids.get(id) {
                report.errors.push(ValidationError::new(
                    ErrorCode::DuplicateId,
                    node.locator("id"),
                    format!(
                        "Component id '{id}' is already used by components[{first}]. Ids must be \
                         unique within a surface; rename this one."
                    ),
                ));
                continue;
            }
            ids.insert(id, node.index);
        }
        ids
    }

    fn check_types_and_props(&self, nodes: &[Node<'_>], report: &mut ValidationReport) {
        let catalog_is_usable = !self.catalog.components.is_empty();
        for node in nodes {
            let Some(kind) = node.kind else {
                report.errors.push(ValidationError::new(
                    ErrorCode::MissingComponentType,
                    node.locator("component"),
                    "Every component needs a 'component' field naming its type, e.g. \
                     \"component\": \"Text\".",
                ));
                continue;
            };
            if !catalog_is_usable {
                continue;
            }
            let Some(def) = self.catalog.component(kind) else {
                // Whether an unfamiliar type is itself an error is the caller's
                // choice; either way there is no definition to check against, so
                // this component is done.
                if self.options.check_component_types {
                    report.errors.push(ValidationError::new(
                        ErrorCode::UnknownComponent,
                        node.locator("component"),
                        format!(
                            "Component type '{kind}' is not in catalog '{}'. Use one of: {}.",
                            self.catalog.catalog_id,
                            self.catalog
                                .components_in_order()
                                .map(|d| d.name.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                    ));
                }
                continue;
            };
            if self.options.check_required_props {
                for required in &def.required {
                    let present = node
                        .props
                        .is_some_and(|props| props.get(required).is_some_and(|v| !v.is_null()));
                    if !present {
                        report.errors.push(ValidationError::new(
                            ErrorCode::MissingRequiredProp,
                            node.locator(required),
                            format!("'{kind}' requires the property '{required}'."),
                        ));
                    }
                }
            }
            if self.options.check_prop_types {
                self.check_prop_types(node, kind, def, report);
            }
        }
    }

    /// Property values against the JSON types the catalog declares.
    ///
    /// Walks the *definition* rather than the value, so a property the catalog
    /// says nothing about costs nothing and is never rejected: an unknown
    /// property is the catalog's business (or the schema's), not this check's.
    fn check_prop_types(
        &self,
        node: &Node<'_>,
        kind: &str,
        def: &ComponentDef,
        report: &mut ValidationReport,
    ) {
        let Some(props) = node.props else { return };
        for prop in def.props.values() {
            if prop.value_type == PropType::Unconstrained {
                continue;
            }
            let Some(value) = props.get(&prop.name) else {
                continue;
            };
            if resolves_at_render_time(value) || prop.value_type.accepts(value) {
                continue;
            }
            report.errors.push(ValidationError::new(
                ErrorCode::TypeMismatch,
                node.locator(&prop.name),
                format!(
                    "'{kind}' expects '{}' to be {}, not {}. Write a literal of that type, or \
                     bind it with {{\"path\": \"/...\"}}.",
                    prop.name,
                    prop.value_type.describe(),
                    type_name(value)
                ),
            ));
        }
    }

    /// How deeply each component nests inside itself, and how long a chain of
    /// function calls it carries.
    ///
    /// Separate from the component *graph* depth checked in
    /// [`Validator::check_cycles`]: a component can be shallow in the tree and
    /// still carry a pathologically nested `action` or data binding.
    fn check_component_depth(&self, nodes: &[Node<'_>], report: &mut ValidationReport) {
        for node in nodes {
            let Some(props) = node.props else { continue };
            for (key, value) in props {
                check_value_depth(
                    value,
                    &node.locator(key),
                    1,
                    self.options.max_depth,
                    self.options.max_function_call_depth,
                    report,
                );
            }
        }
    }

    /// Child edges, reporting references that do not resolve.
    fn build_adjacency(
        &self,
        nodes: &[Node<'_>],
        ids: &BTreeMap<&str, usize>,
        report: &mut ValidationReport,
    ) -> Vec<Vec<Edge>> {
        let mut adjacency: Vec<Vec<Edge>> = vec![Vec::new(); nodes.len()];
        for node in nodes {
            let Some(component) = node.component() else {
                continue;
            };
            for reference in self.catalog.references(component) {
                match ids.get(reference.id.as_str()) {
                    Some(&target) => adjacency[node.index].push(Edge {
                        target,
                        location: reference.location,
                    }),
                    None if self.options.allow_dangling_children => {}
                    None => report.errors.push(ValidationError::new(
                        ErrorCode::UnresolvedChild,
                        node.locator(&reference.location),
                        format!(
                            "Component '{}' references '{}', which is not defined in this \
                             payload. Add a component with that id, or point at one that exists.",
                            component.id, reference.id
                        ),
                    )),
                }
            }
        }
        adjacency
    }

    /// Iterative depth-first search reporting each distinct cycle once, and
    /// flagging a component graph nested past [`ValidateOptions::max_depth`].
    ///
    /// Iterative rather than recursive because the input is model-generated and
    /// may be arbitrarily deep — the very thing the depth limit reports on. A
    /// back edge to a node still on the current path closes a cycle; a
    /// self-reference is the one-node case of the same thing.
    ///
    /// Depth is measured along the search path, so it is the depth of the first
    /// route the search finds to a node rather than the longest possible one.
    /// That matches every other toolkit, and finding true longest paths in a
    /// general graph is not something a validator should be doing.
    fn check_cycles(
        &self,
        nodes: &[Node<'_>],
        adjacency: &[Vec<Edge>],
        report: &mut ValidationReport,
    ) {
        const WHITE: u8 = 0;
        const GRAY: u8 = 1;
        const BLACK: u8 = 2;

        let mut color = vec![WHITE; nodes.len()];
        let mut reported: BTreeSet<Vec<usize>> = BTreeSet::new();
        let mut reported_depth = false;

        for start in 0..nodes.len() {
            if color[start] != WHITE {
                continue;
            }
            color[start] = GRAY;
            let mut stack: Vec<(usize, usize)> = vec![(start, 0)];

            while let Some(&(node, edge_index)) = stack.last() {
                if edge_index >= adjacency[node].len() {
                    color[node] = BLACK;
                    stack.pop();
                    continue;
                }
                if let Some(top) = stack.last_mut() {
                    top.1 += 1;
                }
                let edge = &adjacency[node][edge_index];
                match color[edge.target] {
                    // `stack.len() - 1` is the depth of `node`, so the target
                    // sits one deeper.
                    WHITE if stack.len() > self.options.max_depth => {
                        if !reported_depth {
                            reported_depth = true;
                            report.errors.push(ValidationError::new(
                                ErrorCode::MaxDepthExceeded,
                                nodes[node].locator(&edge.location),
                                format!(
                                    "Global recursion limit exceeded: logical depth > {}. The \
                                     component tree nests deeper than a renderer will draw; \
                                     flatten it.",
                                    self.options.max_depth
                                ),
                            ));
                        }
                        // Leave the subtree unexplored: it is condemned, and a
                        // pathological payload should not cost more work.
                        color[edge.target] = BLACK;
                    }
                    WHITE => {
                        color[edge.target] = GRAY;
                        stack.push((edge.target, 0));
                    }
                    GRAY => {
                        // Back edge: the cycle is the current path from the
                        // target onwards, closed by this edge.
                        let path: Vec<usize> = stack.iter().map(|(n, _)| *n).collect();
                        let start_of_cycle =
                            path.iter().position(|n| *n == edge.target).unwrap_or(0);
                        let cycle = &path[start_of_cycle..];
                        let mut key = cycle.to_vec();
                        key.sort_unstable();
                        if reported.insert(key) {
                            report
                                .errors
                                .push(self.cycle_error(nodes, cycle, node, edge));
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    fn cycle_error(
        &self,
        nodes: &[Node<'_>],
        cycle: &[usize],
        from: usize,
        edge: &Edge,
    ) -> ValidationError {
        let name = |index: usize| nodes[index].id.unwrap_or("<missing id>");
        let mut chain: Vec<&str> = cycle.iter().map(|index| name(*index)).collect();
        chain.push(name(edge.target));
        // The two lead-ins are the phrasing every A2UI SDK uses for these
        // conditions; keeping them identical means a renderer or an operator
        // reading logs from a mixed-language system sees one vocabulary.
        let detail = if cycle.len() == 1 {
            format!(
                "Self-reference detected: component '{}' references itself in '{}'.",
                name(from),
                edge.location
            )
        } else {
            format!(
                "Circular reference detected: child references form a loop: {}.",
                chain.join(" -> ")
            )
        };
        ValidationError::new(
            ErrorCode::ChildCycle,
            nodes[from].locator(&edge.location),
            format!(
                "{detail} A component tree must be acyclic; break the loop by pointing at a \
                 different component."
            ),
        )
    }

    /// Data bindings: relative paths need a collection scope, and every path
    /// must resolve when a data model is available.
    fn check_bindings(
        &self,
        nodes: &[Node<'_>],
        typed: &[Component],
        ids: &BTreeMap<&str, usize>,
        adjacency: &[Vec<Edge>],
        data_model: Option<&Value>,
        report: &mut ValidationReport,
    ) {
        // The scopes borrow whichever document is in play, so it has to outlive
        // the loop; `null` stands in when the caller supplied none.
        let no_data = Value::Null;
        let has_data = data_model.is_some();
        let data = data_model.unwrap_or(&no_data);
        let scopes = collection_scopes(typed, ids, adjacency, self.catalog, data, has_data);

        for node in nodes {
            let Some(component) = node.component() else {
                continue;
            };
            let Ok(raw) = serde_json::to_value(component) else {
                continue;
            };
            let scope = scopes.get(&node.index);

            for binding in collect_bindings(&raw) {
                let is_absolute = binding.path.starts_with('/');
                // An absolute path goes on the wire verbatim, so a malformed
                // escape can never resolve for any data model. Worth saying so
                // even when no data model is available to check against.
                if self.options.check_binding_syntax
                    && is_absolute
                    && !is_valid_pointer(&binding.path)
                {
                    report.errors.push(ValidationError::new(
                        ErrorCode::UnresolvedBinding,
                        node.locator(&binding.location),
                        format!(
                            "Invalid path syntax: '{}' is not a valid JSON Pointer. Inside a \
                             path, '~' must be written '~0' and '/' must be written '~1'.",
                            binding.path
                        ),
                    ));
                    continue;
                }
                if !self.options.check_bindings {
                    continue;
                }
                if !is_absolute && scope.is_none() {
                    report.errors.push(ValidationError::new(
                        ErrorCode::UnresolvedBinding,
                        node.locator(&binding.location),
                        format!(
                            "Relative path '{}' has nothing to resolve against: component '{}' \
                             is not inside a list template. Use an absolute path starting with \
                             '/'.",
                            binding.path, component.id
                        ),
                    ));
                    continue;
                }
                if !has_data {
                    continue;
                }
                let resolver = match scope {
                    Some(CollectionScope::Resolved(item)) => item.clone(),
                    // The enclosing collection is missing or empty, so there is
                    // no item to resolve a relative path against. The
                    // collection itself is reported on its container.
                    Some(CollectionScope::Unresolvable) if !is_absolute => continue,
                    _ => Scope::root(data),
                };
                let resolved = resolver.resolve(&binding.path);
                match (binding.is_collection, resolved) {
                    (_, None) => report.errors.push(ValidationError::new(
                        ErrorCode::UnresolvedBinding,
                        node.locator(&binding.location),
                        format!(
                            "Path '{}' does not exist in the data model. Add the value with \
                             updateDataModel, or bind to a path that exists.",
                            binding.path
                        ),
                    )),
                    (true, Some(value)) if !value.is_array() => {
                        report.errors.push(ValidationError::new(
                            ErrorCode::UnresolvedBinding,
                            node.locator(&binding.location),
                            format!(
                                "Template path '{}' must point at an array to iterate; it points \
                                 at {}.",
                                binding.path,
                                type_name(value)
                            ),
                        ));
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Whether a string is a syntactically valid RFC 6901 JSON Pointer.
fn is_valid_pointer(path: &str) -> bool {
    crate::binding::pointer_is_valid(path)
}

/// Whether the renderer computes this value rather than reading it literally.
///
/// A `{"path": …}` binding and a `{"call": …}` / `{"functionCall": …}` invocation
/// both carry something other than the property's own value, so the type they
/// have on the wire says nothing about the type the renderer will see.
/// `{componentId, path}` is excluded: that is a child template, and its `path`
/// names a collection rather than a value.
fn resolves_at_render_time(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    (map.contains_key("path") && !map.contains_key("componentId"))
        || map.contains_key("call")
        || map.contains_key("functionCall")
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

#[derive(Debug, Clone)]
struct Edge {
    target: usize,
    location: String,
}

/// The collection scope a component sits in, if any.
enum CollectionScope<'a> {
    /// Relative paths resolve against this item scope.
    Resolved(Scope<'a>),
    /// Inside a template whose collection could not be resolved, so relative
    /// paths cannot be checked here.
    Unresolvable,
}

/// Assigns a collection scope to every component reachable through a template.
///
/// A `ChildList` template opens one scope per element of the bound array. For
/// validation we resolve relative paths against the **first** element, which is
/// enough to catch typos without iterating data that may be huge or absent.
/// Subtrees under a template inherit its scope; nested templates compose.
fn collection_scopes<'a>(
    components: &[Component],
    ids: &BTreeMap<&str, usize>,
    adjacency: &[Vec<Edge>],
    catalog: &Catalog,
    data: &'a Value,
    has_data: bool,
) -> BTreeMap<usize, CollectionScope<'a>> {
    let mut scopes: BTreeMap<usize, CollectionScope<'a>> = BTreeMap::new();
    let mut queue: Vec<(usize, Option<Scope<'a>>)> = Vec::new();

    // Seed from every template edge.
    for component in components {
        let Some(&index) = ids.get(component.id.as_str()) else {
            continue;
        };
        for reference in catalog.references(component) {
            let Some(collection_path) = template_path(component, &reference.location) else {
                continue;
            };
            let Some(&target) = ids.get(reference.id.as_str()) else {
                continue;
            };
            // Templates nested inside another template resolve their collection
            // path in the outer scope.
            let base = match scopes.get(&index) {
                Some(CollectionScope::Resolved(outer)) => outer.clone(),
                Some(CollectionScope::Unresolvable) | None => Scope::root(data),
            };
            let item = base.item(&collection_path, 0);
            let resolvable = has_data
                && base
                    .resolve(&collection_path)
                    .and_then(Value::as_array)
                    .is_some_and(|items| !items.is_empty());
            queue.push((target, resolvable.then_some(item)));
        }
    }

    // Propagate scopes down the subtree under each template.
    let mut guard = 0usize;
    while let Some((index, scope)) = queue.pop() {
        guard += 1;
        if guard > adjacency.len() * adjacency.len() + adjacency.len() {
            break; // Cyclic input; cycles are reported separately.
        }
        let entry = match &scope {
            Some(item) => CollectionScope::Resolved(item.clone()),
            None => CollectionScope::Unresolvable,
        };
        if scopes.insert(index, entry).is_some() {
            continue;
        }
        for edge in &adjacency[index] {
            queue.push((edge.target, scope.clone()));
        }
    }
    scopes
}

/// The collection path of a template edge, if this reference is one.
fn template_path(component: &Component, location: &str) -> Option<String> {
    let prop = location.strip_suffix(".componentId")?;
    component
        .props
        .get(prop)?
        .as_object()?
        .get("path")?
        .as_str()
        .map(str::to_string)
}

/// Fields of each agent → renderer operation: name, JSON type, and whether the
/// protocol requires it.
///
/// Transcribed from the payload structs in [`crate::message`], which are the
/// port of the v0.9 wire format. Fields the specification leaves untyped (an
/// `updateDataModel` value, a function's arguments) are simply absent: this is
/// the envelope contract, not a schema for everything inside it.
pub(crate) type EnvelopeField = (&'static str, PropType, bool);
pub(crate) const OPERATIONS: [(&str, &[EnvelopeField]); 4] = [
    (
        "createSurface",
        &[
            ("surfaceId", PropType::String, true),
            ("catalogId", PropType::String, true),
            ("theme", PropType::Object, false),
            ("sendDataModel", PropType::Boolean, false),
        ],
    ),
    (
        "updateComponents",
        &[
            ("surfaceId", PropType::String, true),
            ("components", PropType::Array, true),
        ],
    ),
    (
        "updateDataModel",
        &[
            ("surfaceId", PropType::String, true),
            ("path", PropType::String, false),
        ],
    ),
    ("deleteSurface", &[("surfaceId", PropType::String, true)]),
];

/// Checks one message against the v0.9 envelope contract.
///
/// Every other toolkit gets this from `server_to_client.json` through a JSON
/// Schema engine. This crate speaks exactly one protocol version (see
/// `docs/DESIGN.md`), so the contract is a table rather than a document — and a
/// table is what lets a failure carry a locator into the message the caller
/// sent, rather than a path into a schema the caller never saw. The codes match
/// the ones the schema-driven toolkits report, because callers route on them.
///
/// Only agent → renderer messages belong here: a renderer's reply is not agent
/// output and is not part of a payload this validator is asked about.
fn check_envelope(message: &Value, locator: &str, report: &mut ValidationReport) {
    let Some(map) = message.as_object() else {
        report.errors.push(ValidationError::new(
            ErrorCode::TypeMismatch,
            locator,
            format!("A message must be an object, not {}.", type_name(message)),
        ));
        return;
    };

    match map.get("version") {
        Some(Value::String(version)) if matches!(version.as_str(), "v0.9" | "v0.9.1") => {}
        Some(version) => report.errors.push(ValidationError::new(
            ErrorCode::InvalidValue,
            format!("{locator}.version"),
            format!(
                "This crate speaks A2UI {PROTOCOL_VERSION}, but the message declares {version}. \
                 Every message in a stream carries the same version."
            ),
        )),
        None => report.errors.push(ValidationError::new(
            ErrorCode::MissingField,
            format!("{locator}.version"),
            format!("Every message needs \"version\": \"{PROTOCOL_VERSION}\"."),
        )),
    }

    if map.keys().filter(|key| key.as_str() != "version").count() != 1 {
        report.errors.push(ValidationError::new(
            ErrorCode::InvalidValue,
            locator,
            "Exactly one A2UI payload key is required.",
        ));
    }

    let Some((key, fields)) = OPERATIONS
        .iter()
        .find(|(key, _)| map.contains_key(*key))
        .copied()
    else {
        let names: Vec<&str> = OPERATIONS.iter().map(|(key, _)| *key).collect();
        report.errors.push(ValidationError::new(
            ErrorCode::MissingField,
            locator.to_string(),
            format!(
                "A message must carry one of {}. This one carries {:?}.",
                names.join(", "),
                map.keys().collect::<Vec<_>>()
            ),
        ));
        return;
    };

    let Some(payload) = map[key].as_object() else {
        report.errors.push(ValidationError::new(
            ErrorCode::TypeMismatch,
            format!("{locator}.{key}"),
            format!("'{key}' must be an object, not {}.", type_name(&map[key])),
        ));
        return;
    };
    for (field, value_type, required) in fields {
        match payload.get(*field) {
            Some(value) if !value.is_null() => {
                if !value_type.accepts(value) {
                    report.errors.push(ValidationError::new(
                        ErrorCode::TypeMismatch,
                        format!("{locator}.{key}.{field}"),
                        format!(
                            "'{field}' of '{key}' must be {}, not {}.",
                            value_type.describe(),
                            type_name(value)
                        ),
                    ));
                }
            }
            _ if *required => report.errors.push(ValidationError::new(
                ErrorCode::MissingField,
                format!("{locator}.{key}.{field}"),
                format!("'{key}' requires the field '{field}'."),
            )),
            _ => {}
        }
    }
}

/// Reports JSON nesting and function-call chains that run past their limits.
///
/// Iterative with an explicit stack: the input is model-generated, and a
/// recursive walk over it is exactly the stack overflow this check exists to
/// prevent. `base_depth` is the depth `value` already sits at within its
/// enclosing document.
///
/// A `components` array is skipped, because components are checked one at a
/// time with locators that name the offending one; walking them here as well
/// would report the same nesting twice under a vaguer path.
///
/// At most one error of each kind is reported — a payload that is too deep is
/// too deep once, and listing every node past the limit would bury the point.
fn check_value_depth(
    value: &Value,
    path: &str,
    base_depth: usize,
    max_depth: usize,
    max_function_call_depth: usize,
    report: &mut ValidationReport,
) {
    let mut reported_depth = false;
    let mut reported_calls = false;
    let mut stack: Vec<(&Value, usize, usize)> = vec![(value, base_depth, 0)];

    while let Some((current, depth, call_depth)) = stack.pop() {
        if depth > max_depth {
            if !reported_depth {
                reported_depth = true;
                report.errors.push(ValidationError::new(
                    ErrorCode::MaxDepthExceeded,
                    path,
                    format!(
                        "Global recursion limit exceeded: depth > {max_depth}. Flatten the \
                         structure; a renderer will not draw nesting this deep."
                    ),
                ));
            }
            // Stop descending: the message is already condemned, and walking
            // the rest costs time on input that is probably adversarial.
            continue;
        }

        match current {
            Value::Array(items) => {
                for item in items {
                    stack.push((item, depth + 1, call_depth));
                }
            }
            Value::Object(map) => {
                // Two spellings of a function call, and both nest: a
                // `{"functionCall": ...}` wrapper, and the `{call, args}` object
                // it wraps. Each costs one level, so a chain written with both
                // spends the budget twice as fast as the number suggests. That
                // is what every other toolkit counts, and a payload one of them
                // rejects must be rejected here too.
                let wrapper = map.get("functionCall").filter(|value| value.is_object());
                let is_call = map.contains_key("call") && map.contains_key("args");

                if (wrapper.is_some() || is_call) && call_depth >= max_function_call_depth {
                    if !reported_calls {
                        reported_calls = true;
                        report.errors.push(ValidationError::new(
                            ErrorCode::MaxDepthExceeded,
                            path,
                            format!(
                                "Recursion limit exceeded: functionCall depth > \
                                 {max_function_call_depth}. Compute the value before sending it \
                                 rather than chaining more calls."
                            ),
                        ));
                    }
                    continue;
                }

                if let Some(wrapper) = wrapper {
                    stack.push((wrapper, depth + 1, call_depth + 1));
                    continue;
                }
                for (key, child) in map {
                    if key == "components" {
                        continue;
                    }
                    let next_call_depth = if is_call && key == "args" {
                        call_depth + 1
                    } else {
                        call_depth
                    };
                    stack.push((child, depth + 1, next_call_depth));
                }
            }
            _ => {}
        }
    }
}

/// Node indices reachable from the root, or `None` when there is no root.
fn reachable_from_root(
    ids: &BTreeMap<&str, usize>,
    adjacency: &[Vec<Edge>],
    root_id: &str,
) -> Option<BTreeSet<usize>> {
    let root = *ids.get(root_id)?;
    let mut seen = BTreeSet::new();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if !seen.insert(node) {
            continue;
        }
        for edge in &adjacency[node] {
            stack.push(edge.target);
        }
    }
    Some(seen)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn basic() -> Catalog {
        Catalog::basic()
    }

    fn codes(report: &ValidationReport) -> Vec<ErrorCode> {
        report.errors.iter().map(|e| e.code).collect()
    }

    #[test]
    fn a_well_formed_surface_validates_clean() {
        let catalog = basic();
        let components = vec![
            Component::new("root", "Column").with("children", json!(["title", "cta"])),
            Component::new("title", "Text").with("text", json!("Hello")),
            Component::new("cta", "Button")
                .with("child", json!("title"))
                .with("action", json!({"event": {"name": "go"}})),
        ];
        let report = Validator::new(&catalog).validate(&components);
        assert!(report.is_valid(), "{:?}", report.errors);
        assert!(report.unreachable.is_empty());
    }

    #[test]
    fn empty_components_is_reported_once() {
        let report = Validator::new(&basic()).validate(&[]);
        assert_eq!(codes(&report), vec![ErrorCode::EmptyComponents]);
        assert_eq!(report.errors[0].path, "components");
    }

    #[test]
    fn missing_id_and_type_come_from_raw_json() {
        let catalog = basic();
        let report = Validator::new(&catalog).validate_json(
            &[
                json!({"component": "Text", "text": "x"}),
                json!({"id": "b"}),
            ],
            None,
        );
        assert!(codes(&report).contains(&ErrorCode::MissingId));
        assert!(codes(&report).contains(&ErrorCode::MissingComponentType));
        assert_eq!(
            report
                .errors
                .iter()
                .find(|e| e.code == ErrorCode::MissingId)
                .unwrap()
                .path,
            "components[0].id"
        );
        assert_eq!(
            report
                .errors
                .iter()
                .find(|e| e.code == ErrorCode::MissingComponentType)
                .unwrap()
                .path,
            "components[1].component"
        );
    }

    #[test]
    fn duplicate_ids_point_at_the_later_component() {
        let catalog = basic();
        let components = vec![
            Component::new("root", "Text").with("text", json!("a")),
            Component::new("dup", "Text").with("text", json!("b")),
            Component::new("dup", "Text").with("text", json!("c")),
        ];
        let report = Validator::new(&catalog).validate(&components);
        let error = report
            .errors
            .iter()
            .find(|e| e.code == ErrorCode::DuplicateId)
            .unwrap();
        assert_eq!(error.path, "components[2].id");
        assert!(error.message.contains("components[1]"));
    }

    #[test]
    fn a_missing_root_is_reported_for_full_surfaces_only() {
        let catalog = basic();
        let components = vec![Component::new("c1", "Text").with("text", json!("hi"))];
        assert!(
            codes(&Validator::new(&catalog).validate(&components)).contains(&ErrorCode::NoRoot)
        );
        assert!(
            Validator::incremental(&catalog)
                .validate(&components)
                .is_valid()
        );
    }

    #[test]
    fn unknown_component_types_are_rejected_against_the_catalog() {
        let catalog = basic();
        let report = Validator::new(&catalog)
            .validate(&[Component::new("root", "Sparkline").with("data", json!([1, 2]))]);
        let error = report
            .errors
            .iter()
            .find(|e| e.code == ErrorCode::UnknownComponent)
            .unwrap();
        assert_eq!(error.path, "components[0].component");
        assert!(error.message.contains("Text"));
    }

    #[test]
    fn required_props_are_enforced_per_component_type() {
        let catalog = basic();
        let report = Validator::new(&catalog).validate(&[
            Component::new("root", "Column").with("children", json!(["t"])),
            Component::new("t", "Text"),
        ]);
        let error = report
            .errors
            .iter()
            .find(|e| e.code == ErrorCode::MissingRequiredProp)
            .unwrap();
        assert_eq!(error.path, "components[1].text");
    }

    #[test]
    fn unresolved_children_are_located_precisely() {
        let catalog = basic();
        let report = Validator::new(&catalog).validate(&[
            Component::new("root", "Row").with("children", json!(["there", "gone"])),
            Component::new("there", "Text").with("text", json!("x")),
        ]);
        let error = report
            .errors
            .iter()
            .find(|e| e.code == ErrorCode::UnresolvedChild)
            .unwrap();
        assert_eq!(error.path, "components[0].children[1]");
        assert!(error.message.contains("'gone'"));
    }

    #[test]
    fn template_references_are_resolved_like_any_other_child() {
        let catalog = basic();
        let ok = Validator::new(&catalog).validate(&[
            Component::new("root", "List")
                .with("children", json!({"componentId": "tpl", "path": "/items"})),
            Component::new("tpl", "Text").with("text", json!({"path": "label"})),
        ]);
        assert!(ok.is_valid(), "{:?}", ok.errors);

        let broken = Validator::new(&catalog).validate(&[Component::new("root", "List").with(
            "children",
            json!({"componentId": "missing", "path": "/items"}),
        )]);
        let error = broken
            .errors
            .iter()
            .find(|e| e.code == ErrorCode::UnresolvedChild)
            .unwrap();
        assert_eq!(error.path, "components[0].children.componentId");
    }

    #[test]
    fn dangling_children_are_allowed_for_incremental_updates() {
        let catalog = basic();
        let components = vec![Component::new("card", "Card").with("child", json!("elsewhere"))];
        assert!(!Validator::new(&catalog).validate(&components).is_valid());
        assert!(
            Validator::incremental(&catalog)
                .validate(&components)
                .is_valid()
        );
    }

    #[test]
    fn self_reference_is_a_cycle_even_in_incremental_updates() {
        let catalog = basic();
        let components = vec![Component::new("card", "Card").with("child", json!("card"))];
        let report = Validator::incremental(&catalog).validate(&components);
        let error = report
            .errors
            .iter()
            .find(|e| e.code == ErrorCode::ChildCycle)
            .unwrap();
        assert_eq!(error.path, "components[0].child");
        assert!(error.message.contains("Self-reference detected"));
    }

    #[test]
    fn two_node_cycles_are_reported_once_with_the_chain() {
        let catalog = basic();
        let components = vec![
            Component::new("root", "Card").with("child", json!("c1")),
            Component::new("c1", "Card").with("child", json!("root")),
        ];
        let report = Validator::new(&catalog).validate(&components);
        let cycles: Vec<_> = report
            .errors
            .iter()
            .filter(|e| e.code == ErrorCode::ChildCycle)
            .collect();
        assert_eq!(cycles.len(), 1, "{:?}", report.errors);
        assert!(cycles[0].message.contains("Circular reference detected"));
        assert!(cycles[0].message.contains("root -> c1 -> root"));
    }

    #[test]
    fn cycles_are_found_when_they_are_unreachable_from_the_root() {
        let catalog = basic();
        let components = vec![
            Component::new("root", "Text").with("text", json!("hi")),
            Component::new("a", "Card").with("child", json!("b")),
            Component::new("b", "Card").with("child", json!("a")),
        ];
        let report = Validator::new(&catalog).validate(&components);
        assert_eq!(
            report
                .errors
                .iter()
                .filter(|e| e.code == ErrorCode::ChildCycle)
                .count(),
            1
        );
        assert_eq!(report.unreachable, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn distinct_cycles_are_each_reported() {
        let catalog = basic();
        let components = vec![
            Component::new("root", "Row").with("children", json!(["a", "c"])),
            Component::new("a", "Card").with("child", json!("b")),
            Component::new("b", "Card").with("child", json!("a")),
            Component::new("c", "Card").with("child", json!("c")),
        ];
        let report = Validator::new(&catalog).validate(&components);
        assert_eq!(
            report
                .errors
                .iter()
                .filter(|e| e.code == ErrorCode::ChildCycle)
                .count(),
            2
        );
    }

    /// A chain of `Card`s `depth` links long, rooted at `root`.
    fn deep_chain(depth: usize) -> Vec<Component> {
        let mut components = Vec::with_capacity(depth + 2);
        components.push(Component::new("root", "Card").with("child", json!("n0")));
        for i in 0..depth {
            let next = if i + 1 == depth {
                json!("leaf")
            } else {
                json!(format!("n{}", i + 1))
            };
            components.push(Component::new(format!("n{i}"), "Card").with("child", next));
        }
        components.push(Component::new("leaf", "Text").with("text", json!("end")));
        components
    }

    /// A value nested `depth` objects deep.
    fn deep_value(depth: usize) -> Value {
        let mut value = json!({"level": depth});
        for level in (0..depth).rev() {
            value = json!({"level": level, "next": value});
        }
        value
    }

    #[test]
    fn a_tree_deeper_than_the_limit_is_reported_not_crashed() {
        let catalog = basic();
        // Far past the limit, and far past what any stack would survive if the
        // walk recursed.
        let report = Validator::new(&catalog).validate(&deep_chain(50_000));
        let depth_errors: Vec<_> = report
            .errors
            .iter()
            .filter(|e| e.code == ErrorCode::MaxDepthExceeded)
            .collect();
        assert_eq!(depth_errors.len(), 1, "reported once, not once per node");
        assert!(depth_errors[0].message.contains("logical depth > 50"));
        assert_eq!(depth_errors[0].path, "components[50].child");
    }

    #[test]
    fn the_depth_limit_is_policy_not_what_keeps_the_walk_safe() {
        // With the limit lifted, the same 50k-deep tree still validates: every
        // walk is iterative, so nothing here depends on the cap to survive.
        // This is the test that would blow the stack if a walk recursed.
        let catalog = basic();
        let options = ValidateOptions::full_surface().with_max_depth(usize::MAX);
        let report = Validator::with_options(&catalog, options).validate(&deep_chain(50_000));
        assert!(
            report.is_valid(),
            "{:?}",
            &report.errors[..report.errors.len().min(3)]
        );
    }

    #[test]
    fn json_from_the_wire_is_depth_bounded_before_this_crate_sees_it() {
        // The value walks in this crate recurse, and this is why that is safe:
        // anything arriving as text has already been through serde_json, which
        // refuses to build a `Value` nested deeper than 128. If that ever
        // changes, those walks need the same treatment as the graph walks.
        let ok = format!("{}{}", "[".repeat(127), "]".repeat(127));
        assert!(serde_json::from_str::<Value>(&ok).is_ok());

        let too_deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
        let error = serde_json::from_str::<Value>(&too_deep).unwrap_err();
        assert!(
            error.to_string().contains("recursion limit exceeded"),
            "{error}"
        );
    }

    #[test]
    fn a_chain_within_the_limit_is_accepted() {
        let catalog = basic();
        // root -> n0..n47 -> leaf is 49 links, one inside the limit.
        let report = Validator::new(&catalog).validate(&deep_chain(48));
        assert!(report.is_valid(), "{:?}", report.errors);
    }

    #[test]
    fn deeply_nested_json_inside_a_component_is_reported() {
        let catalog = basic();
        let component = Component::new("root", "Text")
            .with("text", json!("hi"))
            .with("accessibility", deep_value(400));
        let report = Validator::new(&catalog).validate(&[component]);
        let error = report
            .errors
            .iter()
            .find(|e| e.code == ErrorCode::MaxDepthExceeded)
            .expect("a depth error");
        assert!(error.message.contains("depth > 50"));
        assert_eq!(error.path, "components[0].accessibility");
    }

    #[test]
    fn a_deeply_nested_data_model_is_reported_on_the_message() {
        let catalog = basic();
        let messages = vec![json!({
            "version": "v0.9",
            "updateDataModel": {"surfaceId": "s", "value": deep_value(400)}
        })];
        let report = Validator::new(&catalog).validate_json_messages(&messages);
        let error = report
            .errors
            .iter()
            .find(|e| e.code == ErrorCode::MaxDepthExceeded)
            .expect("a depth error");
        assert!(error.message.contains("Global recursion limit exceeded"));
        assert_eq!(error.path, "messages[0]");
    }

    #[test]
    fn a_chain_of_function_calls_past_the_limit_is_reported() {
        let catalog = basic();
        // Six nested calls, one past the budget of five.
        let mut call = json!({"call": "f5", "args": {}});
        for level in (0..5).rev() {
            call = json!({"call": format!("f{level}"), "args": {"functionCall": call}});
        }
        let component = Component::new("root", "Button")
            .with("child", json!("root"))
            .with("action", json!({"functionCall": call}));

        let report = Validator::with_options(
            &catalog,
            ValidateOptions {
                // Isolate the call-depth check from the cycle this component
                // has for brevity.
                ..ValidateOptions::incremental_update()
            },
        )
        .validate(&[component]);
        let error = report
            .errors
            .iter()
            .find(|e| e.code == ErrorCode::MaxDepthExceeded)
            .expect("a depth error");
        assert!(error.message.contains("functionCall depth > 5"), "{error}");
        assert_eq!(error.path, "components[0].action");
    }

    #[test]
    fn a_short_chain_of_function_calls_is_accepted() {
        let catalog = basic();
        // Two calls. The budget of five is spent two levels per call, because
        // the wrapper and the call object each count, so this is close to the
        // practical ceiling.
        let mut call = json!({"call": "f1", "args": {}});
        for level in (0..1).rev() {
            call = json!({"call": format!("f{level}"), "args": {"functionCall": call}});
        }
        let components = vec![
            Component::new("root", "Button")
                .with("child", json!("label"))
                .with("action", json!({"functionCall": call})),
            Component::new("label", "Text").with("text", json!("go")),
        ];
        let report = Validator::new(&catalog).validate(&components);
        assert!(report.is_valid(), "{:?}", report.errors);
    }

    #[test]
    fn unreachable_components_are_warnings_not_errors() {
        let catalog = basic();
        let report = Validator::new(&catalog).validate(&[
            Component::new("root", "Text").with("text", json!("root")),
            Component::new("orphan", "Text").with("text", json!("nobody points here")),
        ]);
        assert!(report.is_valid(), "{:?}", report.errors);
        assert_eq!(report.unreachable, vec!["orphan".to_string()]);
    }

    #[test]
    fn relative_paths_outside_a_template_are_unresolved_bindings() {
        let catalog = basic();
        let report = Validator::new(&catalog)
            .validate(&[Component::new("root", "Text").with("text", json!({"path": "name"}))]);
        let error = report
            .errors
            .iter()
            .find(|e| e.code == ErrorCode::UnresolvedBinding)
            .unwrap();
        assert_eq!(error.path, "components[0].text");
        assert!(error.message.contains("not inside a list template"));
    }

    #[test]
    fn relative_paths_inside_a_template_are_accepted() {
        let catalog = basic();
        let report = Validator::new(&catalog).validate(&[
            Component::new("root", "List")
                .with("children", json!({"componentId": "row", "path": "/people"})),
            Component::new("row", "Text").with("text", json!({"path": "name"})),
        ]);
        assert!(report.is_valid(), "{:?}", report.errors);
    }

    #[test]
    fn bindings_are_resolved_against_a_supplied_data_model() {
        let catalog = basic();
        let components = vec![
            Component::new("root", "Column").with("children", json!(["a", "b"])),
            Component::new("a", "Text").with("text", json!({"path": "/user/name"})),
            Component::new("b", "Text").with("text", json!({"path": "/user/nope"})),
        ];
        let data = json!({"user": {"name": "Ada"}});
        let report = Validator::new(&catalog).validate_surface(&components, Some(&data));
        let errors: Vec<_> = report
            .errors
            .iter()
            .filter(|e| e.code == ErrorCode::UnresolvedBinding)
            .collect();
        assert_eq!(errors.len(), 1, "{:?}", report.errors);
        assert_eq!(errors[0].path, "components[2].text");
    }

    #[test]
    fn template_paths_must_point_at_an_array() {
        let catalog = basic();
        let components = vec![
            Component::new("root", "List")
                .with("children", json!({"componentId": "row", "path": "/people"})),
            Component::new("row", "Text").with("text", json!({"path": "name"})),
        ];
        let data = json!({"people": {"not": "an array"}});
        let report = Validator::new(&catalog).validate_surface(&components, Some(&data));
        let error = report
            .errors
            .iter()
            .find(|e| e.code == ErrorCode::UnresolvedBinding)
            .unwrap();
        assert_eq!(error.path, "components[0].children");
        assert!(error.message.contains("must point at an array"));
    }

    #[test]
    fn relative_paths_resolve_against_the_first_collection_item() {
        let catalog = basic();
        let components = vec![
            Component::new("root", "List")
                .with("children", json!({"componentId": "row", "path": "/people"})),
            Component::new("row", "Column").with("children", json!(["name", "typo"])),
            Component::new("name", "Text").with("text", json!({"path": "name"})),
            Component::new("typo", "Text").with("text", json!({"path": "nmae"})),
        ];
        let data = json!({"people": [{"name": "Ada"}]});
        let report = Validator::new(&catalog).validate_surface(&components, Some(&data));
        let errors: Vec<_> = report
            .errors
            .iter()
            .filter(|e| e.code == ErrorCode::UnresolvedBinding)
            .collect();
        assert_eq!(errors.len(), 1, "{:?}", report.errors);
        assert_eq!(errors[0].path, "components[3].text");
    }

    #[test]
    fn every_error_code_has_a_stable_wire_string() {
        let all = [
            (ErrorCode::EmptyComponents, "empty_components"),
            (ErrorCode::MissingId, "missing_id"),
            (ErrorCode::MissingComponentType, "missing_component_type"),
            (ErrorCode::DuplicateId, "duplicate_id"),
            (ErrorCode::NoRoot, "no_root"),
            (ErrorCode::UnknownComponent, "unknown_component"),
            (ErrorCode::MissingRequiredProp, "missing_required_prop"),
            (ErrorCode::MissingField, "missing_field"),
            (ErrorCode::InvalidValue, "invalid_value"),
            (ErrorCode::TypeMismatch, "type_mismatch"),
            (ErrorCode::UnresolvedChild, "unresolved_child"),
            (ErrorCode::ChildCycle, "child_cycle"),
            (ErrorCode::UnresolvedBinding, "unresolved_binding"),
            (ErrorCode::MaxDepthExceeded, "max_depth_exceeded"),
        ];
        for (code, wire) in all {
            assert_eq!(code.as_str(), wire);
            assert_eq!(serde_json::to_value(code).unwrap(), json!(wire));
        }
    }

    #[test]
    fn a_property_of_the_wrong_json_type_is_reported_against_the_catalog() {
        let catalog = basic();
        let report = Validator::new(&catalog).validate(&[
            Component::new("root", "Column").with("children", json!(["count"])),
            // The catalog says Slider.value is a number and Slider.label a
            // string; a model that swaps them produces a surface no renderer can
            // draw, and nothing before this caught it.
            Component::new("count", "Slider")
                .with("value", json!("seven"))
                .with("max", json!(10))
                .with("label", json!(3)),
        ]);
        let mismatches: Vec<&str> = report
            .errors
            .iter()
            .filter(|e| e.code == ErrorCode::TypeMismatch)
            .map(|e| e.path.as_str())
            .collect();
        assert_eq!(
            mismatches,
            vec!["components[1].label", "components[1].value"]
        );
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.message.contains("not a string")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn a_value_the_renderer_computes_is_never_type_checked() {
        let catalog = basic();
        // Every one of these is legal in a string property: a binding, a
        // function call, and the wrapper spelling of a call. Their type on the
        // wire is an object, and rejecting them would break every real surface.
        let report = Validator::new(&catalog).validate(&[
            Component::new("root", "Column").with("children", json!(["a", "b", "c"])),
            Component::new("a", "Text").with("text", json!({"path": "/user/name"})),
            Component::new("b", "Text").with(
                "text",
                json!({"call": "formatString", "args": {"value": "hi"}}),
            ),
            Component::new("c", "Text").with("text", json!({"functionCall": {"call": "now"}})),
        ]);
        assert!(report.is_valid(), "{:?}", report.errors);
    }

    #[test]
    fn a_property_the_catalog_leaves_untyped_accepts_anything() {
        let catalog = basic();
        // `Icon.name` is a string, an `{svgPath}` object, or a binding, so the
        // catalog pins no type and this crate demands none.
        let report = Validator::new(&catalog)
            .validate(&[Component::new("root", "Icon").with("name", json!({"svgPath": "M0 0"}))]);
        assert!(report.is_valid(), "{:?}", report.errors);
    }

    #[test]
    fn type_checking_can_be_switched_off() {
        let catalog = basic();
        let options = ValidateOptions {
            check_prop_types: false,
            ..ValidateOptions::full_surface()
        };
        let report = Validator::with_options(&catalog, options)
            .validate(&[Component::new("root", "Text").with("text", json!(123))]);
        assert!(report.is_valid(), "{:?}", report.errors);
    }

    #[test]
    fn a_message_without_a_version_is_reported_as_a_missing_field() {
        let catalog = basic();
        let messages = vec![json!({"createSurface": {"surfaceId": "s", "catalogId": "c"}})];
        let report = Validator::new(&catalog).validate_json_messages(&messages);
        assert_eq!(codes(&report), vec![ErrorCode::MissingField]);
        assert_eq!(report.errors[0].path, "messages[0].version");
    }

    #[test]
    fn a_message_from_another_protocol_version_is_reported_as_an_invalid_value() {
        let catalog = basic();
        let messages = vec![json!({
            "version": "v0.8",
            "createSurface": {"surfaceId": "s", "catalogId": "c"}
        })];
        let report = Validator::new(&catalog).validate_json_messages(&messages);
        assert_eq!(codes(&report), vec![ErrorCode::InvalidValue]);
        assert_eq!(report.errors[0].path, "messages[0].version");
    }

    #[test]
    fn an_operation_is_held_to_its_own_required_fields_and_types() {
        let catalog = basic();
        let messages = vec![
            json!({"version": "v0.9", "createSurface": {"surfaceId": "s"}}),
            json!({"version": "v0.9", "deleteSurface": {"surfaceId": 123}}),
        ];
        let report = Validator::new(&catalog).validate_json_messages(&messages);
        let located: Vec<(ErrorCode, &str)> = report
            .errors
            .iter()
            .map(|e| (e.code, e.path.as_str()))
            .collect();
        assert_eq!(
            located,
            vec![
                (
                    ErrorCode::MissingField,
                    "messages[0].createSurface.catalogId"
                ),
                (
                    ErrorCode::TypeMismatch,
                    "messages[1].deleteSurface.surfaceId"
                ),
            ]
        );
    }

    #[test]
    fn a_message_carrying_no_operation_at_all_is_reported() {
        let catalog = basic();
        let messages = vec![json!({"version": "v0.9", "action": {"name": "go"}})];
        let report = Validator::new(&catalog).validate_json_messages(&messages);
        assert_eq!(codes(&report), vec![ErrorCode::MissingField]);
        assert_eq!(report.errors[0].path, "messages[0]");
    }

    #[test]
    fn disabling_extra_envelope_checks_does_not_bypass_typed_wire_contract() {
        let catalog = basic();
        let options = ValidateOptions {
            check_envelope: false,
            ..ValidateOptions::incremental_update()
        };
        let messages = vec![
            json!({"updateComponents": {"surfaceId": "s", "components": [
                {"id": "root", "component": "Text", "text": "hi"}
            ]}}),
        ];
        let report = Validator::with_options(&catalog, options).validate_json_messages(&messages);
        assert!(!report.is_valid());
    }

    #[test]
    fn every_message_this_crate_emits_satisfies_its_own_envelope_check() {
        let catalog = basic();
        let messages = vec![
            AgentMessage::create_surface("s", "cat"),
            AgentMessage::update_components(
                "s",
                vec![Component::new(ROOT_ID, "Text").with("text", json!("hi"))],
            ),
            AgentMessage::update_data_model("s", "/user", json!({"name": "Ada"})),
            AgentMessage::delete_surface("s"),
        ];
        let report = Validator::new(&catalog).validate_messages(&messages);
        assert!(report.is_valid(), "{:?}", report.errors);
    }

    #[test]
    fn incremental_streams_require_observed_prior_state() {
        let catalog = basic();
        let validator = Validator::new(&catalog);

        let incremental = vec![AgentMessage::update_components(
            "s",
            vec![Component::new("c", "Card").with("child", json!("already-there"))],
        )];
        assert!(!validator.validate_messages(&incremental).is_valid());

        let full = vec![
            AgentMessage::create_surface("s", "cat"),
            AgentMessage::update_components(
                "s",
                vec![Component::new("c", "Card").with("child", json!("gone"))],
            ),
        ];
        let report = validator.validate_messages(&full);
        assert!(codes(&report).contains(&ErrorCode::NoRoot));
        assert!(codes(&report).contains(&ErrorCode::UnresolvedChild));
    }

    #[test]
    fn validate_messages_replays_the_data_model() {
        let catalog = basic();
        let messages = vec![
            AgentMessage::create_surface("s", "cat"),
            AgentMessage::update_components(
                "s",
                vec![Component::new("root", "Text").with("text", json!({"path": "/user/name"}))],
            ),
            AgentMessage::update_data_model("s", "/user/name", json!("Ada")),
        ];
        assert!(
            Validator::new(&catalog)
                .validate_messages(&messages)
                .is_valid()
        );

        let messages = vec![
            AgentMessage::create_surface("s", "cat"),
            AgentMessage::update_components(
                "s",
                vec![Component::new("root", "Text").with("text", json!({"path": "/user/name"}))],
            ),
            AgentMessage::update_data_model("s", "/user/other", json!("Ada")),
        ];
        let report = Validator::new(&catalog).validate_messages(&messages);
        assert!(codes(&report).contains(&ErrorCode::UnresolvedBinding));
    }

    #[test]
    fn an_empty_catalog_skips_type_checks() {
        let catalog = Catalog::empty("none");
        let report = Validator::new(&catalog)
            .validate(&[Component::new("root", "Whatever").with("x", json!(1))]);
        assert!(report.is_valid(), "{:?}", report.errors);
    }

    #[test]
    fn report_converts_into_a_result_carrying_every_error() {
        let catalog = basic();
        let report = Validator::new(&catalog).validate(&[]);
        let Err(Error::Validation { errors }) = report.into_result() else {
            panic!("expected a validation error");
        };
        assert_eq!(errors.len(), 1);
        assert!(errors.to_string().contains("empty_components"));
    }
}
