//! Error types for the A2UI protocol layer.

use std::fmt;

/// Convenient alias for fallible A2UI operations.
pub type Result<T> = std::result::Result<T, Error>;

/// Everything that can go wrong while producing, validating, or transporting
/// A2UI.
///
/// The variants are deliberately coarse: A2UI is a wire protocol, so the useful
/// detail almost always lives in the payload (a [`crate::validate::ValidationError`]
/// list, a JSON Pointer, the offending literal) rather than in the discriminant.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// The bytes were not JSON, or were not JSON of the expected shape.
    #[error("invalid A2UI JSON: {0}")]
    Json(#[from] serde_json::Error),

    /// An LLM response could not be split into conversational text and A2UI
    /// blocks, or a block did not contain usable JSON.
    #[error("A2UI parse error: {0}")]
    Parse(String),

    /// A syntactically well-formed payload that violates A2UI semantics.
    ///
    /// Carries the full machine-readable error list so a caller can feed it
    #[cfg_attr(
        feature = "toolkit",
        doc = "straight back to a model; see [`crate::toolkit::recovery`]."
    )]
    #[cfg_attr(
        not(feature = "toolkit"),
        doc = "straight back to a model; see `toolkit::recovery`, behind the `toolkit` feature."
    )]
    #[error("A2UI validation failed with {} error(s):\n{errors}", errors.len())]
    Validation {
        /// The full machine-readable error list.
        errors: ValidationErrors,
    },

    /// A JSON Pointer was malformed, or resolved to a location that cannot be
    /// written (for example indexing past the end of an array).
    #[error("invalid data-model pointer {pointer:?}: {reason}")]
    Pointer {
        /// The offending pointer, exactly as it appeared on the wire.
        pointer: String,
        /// Why it could not be resolved.
        reason: String,
    },

    /// A `${...}` expression in a `formatString` template could not be parsed
    /// or evaluated.
    #[error("invalid binding expression {expression:?}: {reason}")]
    Binding {
        /// The expression body, without the surrounding `${` and `}`.
        expression: String,
        /// Why it could not be evaluated.
        reason: String,
    },

    /// A catalog document could not be interpreted as an A2UI catalog.
    #[error("invalid catalog: {0}")]
    Catalog(String),

    /// The provider failed; its original error remains available as the source.
    #[error("A2UI provider generation failed: {0}")]
    Generation(#[source] Box<dyn std::error::Error + Send + Sync>),

    /// A model cannot be exported as JSON without losing undefined values.
    #[error("A2UI model contains an undefined value at {0}")]
    Undefined(String),

    /// A model failed to produce a valid surface within
    /// [`MAX_A2UI_ATTEMPTS`](crate::constants::MAX_A2UI_ATTEMPTS) attempts.
    #[error("A2UI generation gave up after {attempts} attempt(s); last errors: {last}")]
    RecoveryExhausted {
        /// How many generation attempts were made.
        attempts: u32,
        /// The validation errors from the final attempt.
        last: ValidationErrors,
    },
}

impl Error {
    /// Preserves a provider error without treating it as model-generated invalid JSON.
    pub fn generation(error: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::Generation(Box::new(error))
    }

    /// Builds a [`Error::Parse`] from anything printable.
    pub fn parse(reason: impl fmt::Display) -> Self {
        Self::Parse(reason.to_string())
    }

    /// Builds a [`Error::Catalog`] from anything printable.
    pub fn catalog(reason: impl fmt::Display) -> Self {
        Self::Catalog(reason.to_string())
    }

    /// Builds a [`Error::Pointer`] for a pointer that could not be resolved.
    pub fn pointer(pointer: impl Into<String>, reason: impl fmt::Display) -> Self {
        Self::Pointer {
            pointer: pointer.into(),
            reason: reason.to_string(),
        }
    }

    /// Builds a [`Error::Binding`] for an expression that could not be evaluated.
    pub fn binding(expression: impl Into<String>, reason: impl fmt::Display) -> Self {
        Self::Binding {
            expression: expression.into(),
            reason: reason.to_string(),
        }
    }
}

/// A list of semantic validation errors, rendered one per line.
///
/// Newtype rather than a bare `Vec` so that [`Error::Validation`] can carry a
/// `Display` impl an LLM can read directly.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ValidationErrors(pub Vec<crate::validate::ValidationError>);

impl ValidationErrors {
    /// Number of errors in the list.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the list is empty (i.e. the payload validated cleanly).
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Borrows the underlying errors.
    pub fn as_slice(&self) -> &[crate::validate::ValidationError] {
        &self.0
    }
}

impl From<Vec<crate::validate::ValidationError>> for ValidationErrors {
    fn from(errors: Vec<crate::validate::ValidationError>) -> Self {
        Self(errors)
    }
}

impl fmt::Display for ValidationErrors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, error) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str("\n")?;
            }
            write!(f, "{error}")?;
        }
        Ok(())
    }
}
