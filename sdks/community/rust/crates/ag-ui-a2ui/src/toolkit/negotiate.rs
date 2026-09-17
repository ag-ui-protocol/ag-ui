//! Agreeing with the renderer on which catalog to speak.
//!
//! An agent knows several catalogs; a renderer supports some subset, and may
//! ship its own inline definitions for components only it has. Before the agent
//! can prompt a model it has to settle which catalog the surface will use, since
//! `createSurface` fixes that choice for the surface's lifetime.
//!
//! [`select_catalog`] is that negotiation. The renderer's preference order wins
//! — it is the one that has to draw the result. An inline catalog is selected
//! as a complete document under its own advertised ID.
//!
//! ```
//! use ag_ui_a2ui::toolkit::negotiate::{select_catalog_schema, ClientCapabilities};
//! use serde_json::json;
//!
//! let mine = vec![json!({"catalogId": "basic"}), json!({"catalogId": "fancy"})];
//! let renderer = ClientCapabilities {
//!     supported_catalog_ids: vec!["fancy".into(), "basic".into()],
//!     inline_catalogs: vec![],
//! };
//!
//! let chosen = select_catalog_schema(&mine, &renderer, false).unwrap();
//! assert_eq!(chosen["catalogId"], "fancy");
//! ```

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::catalog::Catalog;
use crate::error::{Error, Result};
use crate::toolkit::schema::SchemaBundle;

/// What a renderer says it can draw.
///
/// Carried in transport metadata as `a2uiClientCapabilities`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientCapabilities {
    /// Catalog ids the renderer supports, most preferred first.
    pub supported_catalog_ids: Vec<String>,
    /// Catalog documents the renderer supplies itself.
    #[serde(default)]
    pub inline_catalogs: Vec<Value>,
}

impl ClientCapabilities {
    /// Capabilities naming a preference order and nothing else.
    pub fn supporting<I, S>(ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            supported_catalog_ids: ids.into_iter().map(Into::into).collect(),
            inline_catalogs: Vec::new(),
        }
    }
}

/// Picks the catalog document both sides can speak.
///
/// The renderer's order is the preference order. Accepted inline documents
/// remain whole; they are never merged into another catalog under its ID.
/// Missing matches and conflicting definitions are explicit errors.
///
/// # Errors
///
/// Returns [`Error::Catalog`] when the renderer supports none of the agent's
/// catalogs, when it offers inline catalogs the agent does not accept, or when
/// the agent has no catalogs at all.
pub fn select_catalog_schema(
    supported: &[Value],
    capabilities: &ClientCapabilities,
    accepts_inline: bool,
) -> Result<Value> {
    if !capabilities.inline_catalogs.is_empty() && !accepts_inline {
        return Err(Error::catalog("the agent does not accept inline catalogs"));
    }
    let mut candidates = std::collections::BTreeMap::new();
    for document in supported.iter().chain(&capabilities.inline_catalogs) {
        let id = document
            .get("catalogId")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::catalog("catalogId is required"))?;
        if let Some(previous) = candidates.insert(id, document) {
            if previous != document {
                return Err(Error::catalog(format!(
                    "conflicting definitions for catalog {id}"
                )));
            }
        }
    }
    capabilities
        .supported_catalog_ids
        .iter()
        .find_map(|id| candidates.get(id.as_str()).map(|v| (*v).clone()))
        .ok_or_else(|| {
            Error::catalog(
                "No client-supported catalog found; advertise the inline catalog ID to select it",
            )
        })
}

/// Wire metadata for the v0.9 family, including v0.9.1 messages. The namespace
/// remains `v0.9` as specified by the official capabilities schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientCapabilitiesWire {
    /// Internal capabilities within the wire version namespace.
    #[serde(rename = "v0.9")]
    pub v0_9: ClientCapabilities,
}
impl ClientCapabilitiesWire {
    /// Validates raw metadata against the pinned official capabilities schema,
    /// then decodes the v0.9 namespace. No resources are fetched.
    #[cfg(feature = "schema-validation")]
    pub fn from_json(value: &Value) -> Result<Self> {
        crate::schema_validation::validate_capabilities(value)?;
        Ok(serde_json::from_value(value.clone())?)
    }
}
impl From<ClientCapabilities> for ClientCapabilitiesWire {
    fn from(v0_9: ClientCapabilities) -> Self {
        Self { v0_9 }
    }
}

/// [`select_catalog_schema`], parsed into a typed [`Catalog`].
///
/// # Errors
///
/// See [`select_catalog_schema`]; also returns [`Error::Catalog`] if the chosen
/// document is not a usable catalog.
pub fn select_catalog(
    supported: &[Value],
    capabilities: &ClientCapabilities,
    accepts_inline: bool,
) -> Result<Catalog> {
    Catalog::from_schema(&select_catalog_schema(
        supported,
        capabilities,
        accepts_inline,
    )?)
}

/// The catalogs an agent knows about.
///
/// Names are how the application refers to a catalog; ids are what goes on the
/// wire. They are usually different — a registry entry called `"standard"` may
/// carry `catalogId: "https://a2ui.org/..."` — so the registry keeps both and
/// [`CatalogRegistry::supported_catalog_ids`] reports the wire ids.
#[derive(Debug, Clone, Default)]
pub struct CatalogRegistry {
    entries: Vec<RegistryEntry>,
}

/// One catalog in a [`CatalogRegistry`].
#[derive(Debug, Clone, PartialEq)]
pub struct RegistryEntry {
    /// The application's name for this catalog.
    pub name: String,
    /// The catalog document.
    pub schema: Value,
}

impl RegistryEntry {
    /// The wire id: the document's `catalogId`, or the local name if it has none.
    pub fn catalog_id(&self) -> &str {
        self.schema
            .get("catalogId")
            .and_then(Value::as_str)
            .unwrap_or(&self.name)
    }
}

impl CatalogRegistry {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a catalog document under a local name.
    pub fn insert(&mut self, name: impl Into<String>, schema: Value) {
        self.entries.push(RegistryEntry {
            name: name.into(),
            schema,
        });
    }

    /// Explicitly registers a second wire ID for the same local catalog.
    /// No aliases are inferred from URL spelling or version strings.
    pub fn insert_alias(&mut self, alias: impl Into<String>, existing: &str) -> Result<()> {
        let alias = alias.into();
        let mut schema = self
            .get(existing)
            .ok_or_else(|| Error::catalog("unknown alias target"))?
            .schema
            .clone();
        schema["catalogId"] = Value::String(alias.clone());
        if self
            .entries
            .iter()
            .any(|e| e.catalog_id() == alias && e.schema != schema)
        {
            return Err(Error::catalog("conflicting catalog alias"));
        }
        self.insert(alias, schema);
        Ok(())
    }

    /// Registers a catalog document read from disk.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Catalog`] if the file cannot be read or is not JSON.
    pub fn load(&mut self, name: impl Into<String>, path: impl AsRef<Path>) -> Result<()> {
        let path = path.as_ref();
        let text = std::fs::read_to_string(path)
            .map_err(|e| Error::catalog(format!("cannot read catalog {}: {e}", path.display())))?;
        let schema = serde_json::from_str(&text)
            .map_err(|e| Error::catalog(format!("catalog {} is not JSON: {e}", path.display())))?;
        self.insert(name, schema);
        Ok(())
    }

    /// Applies `additionalProperties` relaxation to every registered catalog.
    ///
    /// Structured-output APIs reject schemas that forbid extra properties, so
    /// this is usually applied at load time when the catalogs feed one.
    pub fn relax_strict_validation(&mut self) {
        for entry in &mut self.entries {
            crate::toolkit::schema::remove_strict_validation(&mut entry.schema);
        }
    }

    /// The registered catalogs, in registration order.
    pub fn entries(&self) -> &[RegistryEntry] {
        &self.entries
    }

    /// The catalog documents, for [`select_catalog_schema`].
    pub fn schemas(&self) -> Vec<Value> {
        self.entries
            .iter()
            .map(|entry| entry.schema.clone())
            .collect()
    }

    /// The wire ids of every registered catalog.
    pub fn supported_catalog_ids(&self) -> Vec<String> {
        self.entries
            .iter()
            .map(|entry| entry.catalog_id().to_string())
            .collect()
    }

    /// Looks a catalog up by wire id or by local name.
    pub fn get(&self, id: &str) -> Option<&RegistryEntry> {
        self.entries
            .iter()
            .find(|entry| entry.catalog_id() == id || entry.name == id)
    }

    /// Negotiates a catalog from this registry.
    ///
    /// # Errors
    ///
    /// See [`select_catalog_schema`].
    pub fn select(
        &self,
        capabilities: &ClientCapabilities,
        accepts_inline: bool,
    ) -> Result<SchemaBundle> {
        let schema = select_catalog_schema(&self.schemas(), capabilities, accepts_inline)?;
        Ok(SchemaBundle::from_catalog(schema))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agent_catalogs() -> Vec<Value> {
        vec![
            json!({"catalogId": "id_basic", "components": {}}),
            json!({"catalogId": "id_custom1", "components": {}}),
            json!({"catalogId": "id_custom2", "components": {}}),
        ]
    }

    #[test]
    fn no_advertised_catalog_is_not_a_match() {
        assert!(
            select_catalog_schema(&agent_catalogs(), &ClientCapabilities::default(), false)
                .is_err()
        );
    }

    #[test]
    fn the_renderers_order_decides() {
        let chosen = select_catalog_schema(
            &agent_catalogs(),
            &ClientCapabilities::supporting(["id_custom2", "id_custom1"]),
            false,
        )
        .unwrap();
        assert_eq!(chosen["catalogId"], "id_custom2");

        let chosen = select_catalog_schema(
            &agent_catalogs(),
            &ClientCapabilities::supporting(["id_custom1", "id_custom2"]),
            false,
        )
        .unwrap();
        assert_eq!(chosen["catalogId"], "id_custom1");
    }

    #[test]
    fn no_overlap_is_an_error() {
        let error = select_catalog_schema(
            &agent_catalogs(),
            &ClientCapabilities::supporting(["id_not_exists"]),
            false,
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("No client-supported catalog found")
        );
    }

    #[test]
    fn inline_catalog_is_selected_whole_under_its_own_id() {
        let inline = json!({"catalogId":"inline","components":{"X":{}},"functions":[{"name":"f","parameters":{},"returnType":"void"}],"theme":{"color":{"type":"string"}}});
        let caps = ClientCapabilities {
            supported_catalog_ids: vec!["inline".into()],
            inline_catalogs: vec![inline.clone()],
        };
        assert_eq!(
            select_catalog_schema(&agent_catalogs(), &caps, true).unwrap(),
            inline
        );
        let parsed = Catalog::from_schema(&inline).unwrap();
        assert!(parsed.functions.contains_key("f"));
    }
    #[test]
    fn conflicting_same_id_inline_is_rejected() {
        let caps = ClientCapabilities {
            supported_catalog_ids: vec!["id_basic".into()],
            inline_catalogs: vec![json!({"catalogId":"id_basic","components":{"X":{}}})],
        };
        assert!(select_catalog_schema(&agent_catalogs(), &caps, true).is_err());
    }
    #[test]
    fn inline_does_not_rescue_unadvertised_id() {
        let caps = ClientCapabilities {
            supported_catalog_ids: vec!["unknown".into()],
            inline_catalogs: vec![json!({"catalogId":"inline"})],
        };
        assert!(select_catalog_schema(&agent_catalogs(), &caps, true).is_err());
    }
    #[test]
    fn capabilities_wire_namespace_cannot_be_silently_read_as_flat() {
        let raw = json!({"v0.9":{"supportedCatalogIds":["id_basic"]}});
        let wire: ClientCapabilitiesWire = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(wire.v0_9.supported_catalog_ids, vec!["id_basic"]);
        assert_eq!(
            serde_json::to_value(wire).unwrap()["v0.9"]["supportedCatalogIds"],
            raw["v0.9"]["supportedCatalogIds"]
        );
        assert!(serde_json::from_value::<ClientCapabilities>(raw).is_err());
    }

    #[test]
    fn inline_catalogs_are_refused_when_the_agent_says_so() {
        let capabilities = ClientCapabilities {
            supported_catalog_ids: vec![],
            inline_catalogs: vec![json!({"catalogId": "id_inline"})],
        };
        let error =
            select_catalog_schema(&[json!({"catalogId": "id_basic"})], &capabilities, false)
                .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("the agent does not accept inline catalogs")
        );
    }

    #[test]
    fn a_registry_reports_wire_ids_not_local_names() {
        let mut registry = CatalogRegistry::new();
        registry.insert("standard", json!({"catalogId": "basic"}));
        registry.insert("Custom", json!({"components": {}}));
        assert_eq!(
            registry.supported_catalog_ids(),
            vec!["basic".to_string(), "Custom".to_string()]
        );
        assert!(registry.get("basic").is_some());
        assert!(registry.get("standard").is_some());
        assert!(registry.get("nope").is_none());
    }

    #[test]
    fn relaxing_a_registry_strips_strict_validation() {
        let mut registry = CatalogRegistry::new();
        registry.insert(
            "strict",
            json!({"catalogId": "s", "components": {"Text": {"additionalProperties": false}}}),
        );
        registry.relax_strict_validation();
        assert_eq!(
            registry.entries()[0].schema,
            json!({"catalogId": "s", "components": {"Text": {}}})
        );
    }
}
