//! Provider-neutral async authoring with a single immutable validation contract.

use crate::schema_validation::SchemaValidator;
use crate::surface::{SurfaceState, SurfaceStore};
use crate::toolkit::schema::SchemaBundle;
use crate::{A2uiVersion, AgentMessage, AgentPayload, Catalog, DataModel, Error, Result};
use serde_json::Value;
use std::{collections::BTreeMap, future::Future, sync::Arc};

#[derive(Debug)]
struct Contract {
    version: A2uiVersion,
    bundle: SchemaBundle,
    catalog: Catalog,
    schema: SchemaValidator,
}

/// Shared immutable configuration for independently generated surfaces.
#[derive(Debug, Clone)]
pub struct A2uiAuthor {
    contract: Arc<Contract>,
    max_attempts: u32,
}

/// A validated batch and its resulting state. Fields cannot be mutated or
/// deserialized to manufacture successful validation. Revalidate stored history.
#[derive(Debug, Clone)]
pub struct ValidatedSurface {
    operations: Vec<AgentMessage>,
    history: Vec<AgentMessage>,
    state: SurfaceState,
    attempts: u32,
}
impl ValidatedSurface {
    /// Operations in this batch, for transmission exactly once by the caller.
    pub fn operations(&self) -> &[AgentMessage] {
        &self.operations
    }
    /// Full observed operation history, for storage and subsequent revalidation.
    pub fn history(&self) -> &[AgentMessage] {
        &self.history
    }
    /// Renderer-scoped surface ID.
    pub fn surface_id(&self) -> &str {
        &self.state.surface_id
    }
    /// Catalog fixed for the life of this surface.
    pub fn catalog_id(&self) -> &str {
        &self.state.catalog_id
    }
    /// Resulting components, including prior definitions for an edit.
    pub fn components(&self) -> &[crate::Component] {
        &self.state.components
    }
    /// Resulting exact local data model.
    pub fn data_model(&self) -> &DataModel {
        &self.state.data_model
    }
    /// One-based count of generation attempts (zero for manual validation).
    pub fn attempts(&self) -> u32 {
        self.attempts
    }
}

impl A2uiAuthor {
    /// Loads pinned official v0.9.1 schemas, which accept both supported profiles.
    pub fn basic(version: A2uiVersion) -> Result<Self> {
        Self::new(version, SchemaBundle::basic()?, BTreeMap::new())
    }
    /// Creates a custom author from complete schemas and explicit local references.
    pub fn new(
        version: A2uiVersion,
        bundle: SchemaBundle,
        resources: BTreeMap<String, Value>,
    ) -> Result<Self> {
        let catalog = Catalog::from_schema(&bundle.catalog)?;
        let schema = SchemaValidator::new(&bundle, &resources)?;
        Ok(Self {
            contract: Arc::new(Contract {
                version,
                bundle,
                catalog,
                schema,
            }),
            max_attempts: crate::constants::MAX_A2UI_ATTEMPTS,
        })
    }
    /// Limits generated-document correction attempts; provider errors are never retried.
    #[must_use]
    pub fn with_max_attempts(mut self, attempts: u32) -> Self {
        self.max_attempts = attempts.max(1);
        self
    }
    /// Requests a new surface with a fixed ID, version, and catalog.
    pub fn create<'a>(
        &'a self,
        id: impl Into<String>,
        request: impl Into<String>,
    ) -> AuthorRequest<'a> {
        AuthorRequest {
            author: self,
            id: id.into(),
            request: request.into(),
            prior: None,
        }
    }
    /// Requests updates to a previously validated surface. Creation, deletion,
    /// cross-surface updates, and version/catalog changes are rejected.
    pub fn edit<'a>(
        &'a self,
        prior: &'a ValidatedSurface,
        request: impl Into<String>,
    ) -> AuthorRequest<'a> {
        AuthorRequest {
            author: self,
            id: prior.surface_id().into(),
            request: request.into(),
            prior: Some(prior),
        }
    }
    /// Validates stored or manually authored raw messages before any typed decoding.
    pub fn validate_create(&self, id: &str, messages: &[Value]) -> Result<ValidatedSurface> {
        self.validate(id, messages, None)
    }
    /// Validates a manually authored edit using the complete prior state.
    pub fn validate_edit(
        &self,
        prior: &ValidatedSurface,
        messages: &[Value],
    ) -> Result<ValidatedSurface> {
        self.validate(prior.surface_id(), messages, Some(prior))
    }
    fn validate(
        &self,
        id: &str,
        messages: &[Value],
        prior: Option<&ValidatedSurface>,
    ) -> Result<ValidatedSurface> {
        if id.is_empty() || messages.is_empty() {
            return Err(Error::parse(
                "a target surface and nonempty operation batch are required",
            ));
        }
        if let Some(prior) = prior {
            if prior.catalog_id() != self.contract.catalog.catalog_id
                || prior.state.version != self.contract.version.as_str()
            {
                return Err(Error::catalog(
                    "prior surface uses a different catalog or version",
                ));
            }
        }
        if let Some(prior) = prior {
            // A matching catalog ID does not prove that two author instances
            // compiled the same contract. Validate retained wire history before
            // an edit can hide an incompatible old definition by replacing it.
            let history = prior
                .history
                .iter()
                .map(serde_json::to_value)
                .collect::<std::result::Result<Vec<_>, _>>()?;
            self.validate(id, &history, None)?;
        }
        let mut store = match prior {
            Some(p) => SurfaceStore::from_surface(p.state.clone())?,
            None => SurfaceStore::new(),
        };
        let mut operations = Vec::new();
        for raw in messages {
            self.contract.schema.validate_message(raw)?;
            let op: AgentMessage = serde_json::from_value(raw.clone())?;
            if op.version != self.contract.version.as_str() || op.surface_id() != Some(id) {
                return Err(Error::parse(
                    "generated target or version differs from the request",
                ));
            }
            match &op.payload {
                AgentPayload::CreateSurface(create) if prior.is_none() => {
                    if create.catalog_id != self.contract.catalog.catalog_id {
                        return Err(Error::catalog("generated catalog differs from the request"));
                    }
                }
                AgentPayload::UpdateComponents(_) | AgentPayload::UpdateDataModel(_) => {}
                _ => {
                    return Err(Error::parse(
                        "only updates are allowed for edits; create requests allow one create followed by updates",
                    ));
                }
            }
            store.apply(&op)?;
            operations.push(op);
        }
        let state = store
            .get(id)
            .cloned()
            .ok_or_else(|| Error::parse("createSurface is required"))?;
        self.contract
            .schema
            .validate_surface(&state, &self.contract.catalog)?;
        let mut history = prior.map_or_else(Vec::new, |p| p.history.clone());
        history.extend(operations.clone());
        Ok(ValidatedSurface {
            operations,
            history,
            state,
            attempts: 0,
        })
    }
}

/// A request whose model callback is awaited without imposing an executor or Send bound.
#[derive(Debug)]
pub struct AuthorRequest<'a> {
    author: &'a A2uiAuthor,
    id: String,
    request: String,
    prior: Option<&'a ValidatedSurface>,
}
impl AuthorRequest<'_> {
    /// Renders the same target/schema contract that will validate generated output.
    pub fn prompt(&self) -> String {
        let intent = if self.prior.is_some() {
            "Edit the existing surface using updateComponents/updateDataModel only."
        } else {
            "Create exactly one surface, followed by component/data updates."
        };
        let mut prompt = format!(
            "{intent}\nTarget surfaceId: {}\nExact version: {}\nExact catalogId: {}\nRequest: {}\nReturn a JSON array of A2UI messages, optionally inside <a2ui-json> tags.\n{}",
            self.id,
            self.author.contract.version.as_str(),
            self.author.contract.catalog.catalog_id,
            self.request,
            self.author.contract.bundle.render_llm_instructions()
        );
        if let Some(prior) = self.prior {
            prompt.push_str(&format!("\nObserved prior operations (local observation, may be stale):\n{}\nUpdate only requested data paths; preserve unrelated user input.",serde_json::to_string(prior.history()).expect("validated operations serialize")));
        }
        prompt
    }
    /// Generates and corrects invalid documents. Provider errors propagate immediately
    /// with their source. Send callbacks produce Send futures; local callbacks work too.
    pub async fn generate<F, Fut>(self, mut generate: F) -> Result<ValidatedSurface>
    where
        F: FnMut(String, u32) -> Fut,
        Fut: Future<Output = Result<String>>,
    {
        if self.id.is_empty() {
            return Err(Error::parse("target surface ID is required"));
        }
        if let Some(prior) = self.prior {
            let history = prior
                .history
                .iter()
                .map(serde_json::to_value)
                .collect::<std::result::Result<Vec<_>, _>>()?;
            self.author.validate(&self.id, &history, None)?;
        }
        let original = self.prompt();
        let mut prompt = original.clone();
        let mut last = Vec::new();
        for attempt in 1..=self.author.max_attempts {
            let response = generate(prompt, attempt).await?;
            let result = parse_document(&response)
                .and_then(|messages| self.author.validate(&self.id, &messages, self.prior));
            match result {
                Ok(mut surface) => {
                    surface.attempts = attempt;
                    return Ok(surface);
                }
                Err(error) => {
                    last = match error {
                        Error::Validation { errors } => errors.0,
                        other => vec![crate::ValidationError::new(
                            crate::ErrorCode::InvalidValue,
                            "response",
                            other.to_string(),
                        )],
                    };
                    prompt = crate::toolkit::prompt::augment_prompt_with_errors(&original, &last);
                }
            }
        }
        Err(Error::RecoveryExhausted {
            attempts: self.author.max_attempts,
            last: last.into(),
        })
    }
}
fn parse_document(response: &str) -> Result<Vec<Value>> {
    if let Ok(value) = serde_json::from_str::<Value>(response) {
        return match value {
            Value::Array(items) => Ok(items),
            Value::Object(_) => Ok(vec![value]),
            _ => Err(Error::parse("expected A2UI message objects")),
        };
    }
    let parts = crate::toolkit::parser::unwrap_response(response)?;
    let mut messages = Vec::new();
    for part in parts {
        if let Some(raw) = part.raw {
            match serde_json::from_str::<Value>(&raw)? {
                Value::Array(items) => messages.extend(items),
                Value::Object(object) => messages.push(Value::Object(object)),
                _ => return Err(Error::parse("expected message objects")),
            }
        }
    }
    Ok(messages)
}
