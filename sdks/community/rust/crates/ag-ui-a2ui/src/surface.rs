//! Per-renderer surface lifecycle and transactional operation replay.

use crate::{AgentMessage, AgentPayload, Component, DataModel, Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// The observed state of one live or deleted surface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SurfaceState {
    /// Wire version fixed by creation.
    pub version: String,
    /// Renderer-scoped surface ID.
    pub surface_id: String,
    /// Catalog fixed by creation.
    pub catalog_id: String,
    /// Catalog-defined theme observed at creation.
    pub theme: Option<serde_json::Value>,
    /// Whether this surface asks the renderer to echo its data model.
    pub send_data_model: Option<bool>,
    /// Last component definition by ID, in first-definition order.
    pub components: Vec<Component>,
    /// Exact data-model state, including undefined slots.
    pub data_model: DataModel,
    /// A delete was observed; only a new create can make it live.
    pub deleted: bool,
}

/// A single renderer/conversation context. Never share this across users.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SurfaceStore {
    surfaces: BTreeMap<String, SurfaceState>,
}
impl SurfaceStore {
    /// Empty state: updates require a previous create or explicitly supplied prior state.
    pub fn new() -> Self {
        Self::default()
    }
    /// Supplies observed prior state for incremental validation or replay.
    pub fn from_surface(surface: SurfaceState) -> Result<Self> {
        let mut ids = BTreeSet::new();
        if surface.components.iter().any(|c| !ids.insert(c.id.clone())) {
            return Err(Error::parse("duplicate component ID in prior surface"));
        }
        if !matches!(surface.version.as_str(), "v0.9" | "v0.9.1") {
            return Err(Error::parse("unsupported prior surface version"));
        }
        Ok(Self {
            surfaces: BTreeMap::from([(surface.surface_id.clone(), surface)]),
        })
    }
    /// Reads the latest state, including deleted tombstones.
    pub fn get(&self, id: &str) -> Option<&SurfaceState> {
        self.surfaces.get(id)
    }
    /// Every tracked surface in this renderer context.
    pub fn surfaces(&self) -> impl Iterator<Item = &SurfaceState> {
        self.surfaces.values()
    }
    /// Atomically applies one operation. Prior messages are never rolled back.
    pub fn apply(&mut self, message: &AgentMessage) -> Result<()> {
        if !matches!(message.version.as_str(), "v0.9" | "v0.9.1") {
            return Err(Error::parse("unsupported A2UI version"));
        }
        let id = message
            .surface_id()
            .ok_or_else(|| Error::parse("RPC messages are not part of A2UI v0.9 or v0.9.1"))?;
        if let AgentPayload::CreateSurface(create) = &message.payload {
            if self.get(id).is_some_and(|s| !s.deleted) {
                return Err(Error::parse(format!("surface {id:?} already exists")));
            }
            self.surfaces.insert(
                id.into(),
                SurfaceState {
                    version: message.version.clone(),
                    surface_id: id.into(),
                    catalog_id: create.catalog_id.clone(),
                    theme: create.theme.clone(),
                    send_data_model: create.send_data_model,
                    components: vec![],
                    data_model: DataModel::default(),
                    deleted: false,
                },
            );
            return Ok(());
        }
        let mut next = self
            .get(id)
            .filter(|s| !s.deleted)
            .cloned()
            .ok_or_else(|| {
                Error::parse(format!(
                    "surface {id:?} must be created before updating or deleting it"
                ))
            })?;
        // v0.9.1 explicitly accepts either discriminator within the same profile.
        match &message.payload {
            AgentPayload::UpdateComponents(update) => {
                if update.components.is_empty() {
                    return Err(Error::parse("updateComponents must not be empty"));
                }
                let mut seen = BTreeSet::new();
                for component in &update.components {
                    if !seen.insert(&component.id) {
                        return Err(Error::parse(format!(
                            "duplicate component ID {:?} within one message",
                            component.id
                        )));
                    }
                    if let Some(existing) =
                        next.components.iter_mut().find(|c| c.id == component.id)
                    {
                        *existing = component.clone()
                    } else {
                        next.components.push(component.clone())
                    }
                }
            }
            AgentPayload::UpdateDataModel(update) => update.apply_model(&mut next.data_model)?,
            AgentPayload::DeleteSurface(_) => {
                next.deleted = true;
                next.components.clear();
                next.data_model = DataModel::default();
            }
            _ => return Err(Error::parse("unsupported operation")),
        }
        self.surfaces.insert(id.into(), next);
        Ok(())
    }
}
