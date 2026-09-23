//! Full Draft 2020-12 validation with an explicitly local resource registry.

use crate::toolkit::schema::SchemaBundle;
use crate::{Error, ErrorCode, Result, ValidationError};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug)]
struct NoExternalResources;
impl jsonschema::Retrieve for NoExternalResources {
    fn retrieve(
        &self,
        uri: &jsonschema::Uri<String>,
    ) -> std::result::Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err(format!(
            "unregistered schema resource {uri}; network and filesystem retrieval are disabled"
        )
        .into())
    }
}

/// A compiled envelope and catalog schema. Construct once, reuse across requests.
/// Unknown `$ref`s fail construction; URLs never cause network requests.
#[derive(Debug)]
pub struct SchemaValidator {
    compiled: jsonschema::Validator,
}
impl SchemaValidator {
    /// Compiles the official envelope against the supplied catalog and common types.
    /// Additional resources must be supplied locally, keyed by their absolute URI.
    pub fn new(bundle: &SchemaBundle, resources: &BTreeMap<String, Value>) -> Result<Self> {
        let mut registry = resources.clone();
        let mut register = |id: &str, value: &Value| -> Result<()> {
            if let Some(prior) = registry.get(id) {
                if prior != value {
                    return Err(Error::catalog(format!("conflicting schema resource {id}")));
                }
            }
            registry.insert(id.into(), value.clone());
            Ok(())
        };
        for document in [&bundle.s2c, &bundle.common_types, &bundle.catalog] {
            let id = document
                .get("$id")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::catalog("full schema documents require an absolute $id"))?;
            register(id, document)?;
        }
        // Official s2c references this relative URI while the catalog declares
        // its own, longer canonical URI. This is a resolver alias, not a wire ID alias.
        register(
            "https://a2ui.org/specification/v0_9/catalog.json",
            &bundle.catalog,
        )?;
        let mut options = jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .with_retriever(NoExternalResources);
        for (id, document) in registry {
            options = options.with_resource(
                id,
                jsonschema::Resource::from_contents(document).map_err(Error::catalog)?,
            );
        }
        let compiled = options.build(&bundle.s2c).map_err(Error::catalog)?;
        Ok(Self { compiled })
    }
    /// Revalidates a complete observed surface, including prior component definitions
    /// and its creation theme. Useful when restoring state or changing validators.
    pub fn validate_surface(
        &self,
        surface: &crate::surface::SurfaceState,
        catalog: &crate::Catalog,
    ) -> Result<()> {
        let create = crate::AgentMessage {
            version: surface.version.clone(),
            payload: crate::AgentPayload::CreateSurface(crate::message::CreateSurface {
                surface_id: surface.surface_id.clone(),
                catalog_id: surface.catalog_id.clone(),
                theme: surface.theme.clone(),
                send_data_model: surface.send_data_model,
            }),
        };
        self.validate_message(&serde_json::to_value(create)?)?;
        let components = crate::AgentMessage {
            version: surface.version.clone(),
            payload: crate::AgentPayload::UpdateComponents(crate::message::UpdateComponents {
                surface_id: surface.surface_id.clone(),
                components: surface.components.clone(),
            }),
        };
        self.validate_message(&serde_json::to_value(components)?)?;
        crate::Validator::new(catalog)
            .validate_model(&surface.components, &surface.data_model)
            .into_result()?;
        let composition = catalog.composition_violations(&surface.components);
        if !composition.is_empty() {
            return Err(Error::catalog(format!(
                "component composition constraints failed: {composition:?}"
            )));
        }
        Ok(())
    }

    /// Checks raw wire JSON before serde defaults or field filtering can change it.
    pub fn validate_message(&self, message: &Value) -> Result<()> {
        let errors: Vec<_> = self
            .compiled
            .iter_errors(message)
            .map(|e| {
                ValidationError::new(
                    ErrorCode::InvalidValue,
                    e.instance_path.to_string(),
                    e.to_string(),
                )
            })
            .collect();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(Error::Validation {
                errors: errors.into(),
            })
        }
    }
}

/// A stateful validator for one renderer context containing multiple catalogs
/// and surfaces. `push` accepts forward references; `finish` requires complete trees.
#[derive(Debug, Default)]
pub struct SurfaceValidator {
    catalogs: BTreeMap<String, (SchemaValidator, crate::Catalog)>,
    state: crate::surface::SurfaceStore,
}
impl SurfaceValidator {
    /// Empty renderer state and catalog registry.
    pub fn new() -> Self {
        Self::default()
    }
    /// Begins a partial update stream from explicit, previously observed state.
    pub fn from_state(state: crate::surface::SurfaceStore) -> Self {
        Self {
            state,
            ..Self::default()
        }
    }
    /// Registers a complete local catalog contract. Conflicting duplicate IDs
    /// are rejected; create a new validator to change a registered contract.
    pub fn register(
        &mut self,
        bundle: &SchemaBundle,
        resources: &BTreeMap<String, Value>,
    ) -> Result<()> {
        let catalog = crate::Catalog::from_schema(&bundle.catalog)?;
        if self.catalogs.contains_key(&catalog.catalog_id) {
            return Err(Error::catalog("catalog ID is already registered"));
        }
        let validator = SchemaValidator::new(bundle, resources)?;
        self.catalogs
            .insert(catalog.catalog_id.clone(), (validator, catalog));
        Ok(())
    }
    /// Validates raw JSON before decoding, then applies one message atomically.
    /// Unknown catalogs never cause network requests. Invalid messages leave
    /// all previously accepted state unchanged.
    pub fn push(&mut self, raw: &Value) -> Result<()> {
        let catalog_id = if let Some(create) = raw.get("createSurface") {
            create
                .get("catalogId")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::catalog("createSurface.catalogId is required"))?
        } else {
            let surface_id = ["updateComponents", "updateDataModel", "deleteSurface"]
                .iter()
                .find_map(|key| {
                    raw.get(*key)
                        .and_then(|p| p.get("surfaceId"))
                        .and_then(Value::as_str)
                })
                .ok_or_else(|| Error::parse("expected a v0.9-family server message"))?;
            &self
                .state
                .get(surface_id)
                .ok_or_else(|| Error::parse("surface must be created before updating it"))?
                .catalog_id
        };
        let (schema, catalog) = self
            .catalogs
            .get(catalog_id)
            .ok_or_else(|| Error::catalog(format!("unregistered catalog {catalog_id}")))?;
        schema.validate_message(raw)?;
        let op: crate::AgentMessage = serde_json::from_value(raw.clone())?;
        let mut next = self.state.clone();
        next.apply(&op)?;
        if let Some(surface) = op
            .surface_id()
            .and_then(|id| next.get(id))
            .filter(|s| !s.deleted && !s.components.is_empty())
        {
            let options = crate::ValidateOptions {
                check_bindings: false,
                ..crate::ValidateOptions::incremental_update()
            };
            crate::Validator::with_options(catalog, options)
                .validate(&surface.components)
                .into_result()?;
        }
        self.state = next;
        Ok(())
    }
    /// Checks pending roots, references, and bindings at the end of a batch.
    pub fn finish(&self) -> Result<()> {
        for surface in self.state.surfaces().filter(|s| !s.deleted) {
            let (schema, catalog) = self.catalogs.get(&surface.catalog_id).ok_or_else(|| {
                Error::catalog(format!("unregistered catalog {}", surface.catalog_id))
            })?;
            schema.validate_surface(surface, catalog)?;
        }
        Ok(())
    }
    /// Observed accepted state, for incremental streams and lossless replay.
    pub fn state(&self) -> &crate::surface::SurfaceStore {
        &self.state
    }
}

/// Validates raw `a2uiClientCapabilities` metadata using the pinned official schema.
pub fn validate_capabilities(value: &Value) -> Result<()> {
    let schema: Value =
        serde_json::from_str(include_str!("../schemas/v0_9_1/client_capabilities.json"))?;
    let validator = jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .with_retriever(NoExternalResources)
        .build(&schema)
        .map_err(Error::catalog)?;
    validator
        .validate(value)
        .map_err(|e| Error::catalog(e.to_string()))
}
