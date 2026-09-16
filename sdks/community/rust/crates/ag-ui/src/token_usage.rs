//! Per-model token accounting carried by `RUN_FINISHED` and `RUN_ERROR`.

use serde::{Deserialize, Serialize};

/// A numeric-only token usage summary for one `(provider, model)` pair.
///
/// Deliberately carries nothing identifying or content-bearing — no prompts,
/// completions, message text, or thread/run/user ids. Only provider and model
/// labels plus counts, so usage can be logged and aggregated in places where
/// conversation content must not go.
///
/// Every count is optional and every count is a non-negative integer: `None`
/// means *the provider did not report it*, which is distinct from zero.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct TokenUsage {
    /// The inference provider, for example `"anthropic"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// The model id, for example `"claude-opus-5"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Tokens consumed by the prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    /// Tokens produced by the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    /// Total tokens, as reported by the provider (not necessarily the sum of
    /// the other fields).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    /// Output tokens spent on reasoning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    /// Input tokens served from the provider's prompt cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
}

impl TokenUsage {
    /// An empty usage entry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether any count is present. A labels-only entry reports nothing and
    /// should be omitted rather than emitted.
    pub const fn has_counts(&self) -> bool {
        self.input_tokens.is_some()
            || self.output_tokens.is_some()
            || self.total_tokens.is_some()
            || self.reasoning_tokens.is_some()
            || self.cached_input_tokens.is_some()
    }
}

/// Sums per-call [`TokenUsage`] entries into one entry per `(provider, model)`
/// pair, in order of first appearance.
///
/// A count stays `None` when no member of a group reported it, keeping "not
/// reported" distinct from zero.
///
/// ```
/// # use ag_ui::{TokenUsage, aggregate_token_usage};
/// let calls = vec![
///     TokenUsage { model: Some("m".into()), input_tokens: Some(10), ..Default::default() },
///     TokenUsage { model: Some("m".into()), input_tokens: Some(5), ..Default::default() },
/// ];
/// let total = aggregate_token_usage(&calls);
/// assert_eq!(total.len(), 1);
/// assert_eq!(total[0].input_tokens, Some(15));
/// assert_eq!(total[0].output_tokens, None);
/// ```
pub fn aggregate_token_usage(entries: &[TokenUsage]) -> Vec<TokenUsage> {
    let mut grouped: Vec<TokenUsage> = Vec::new();

    for entry in entries {
        let index = match grouped
            .iter()
            .position(|g| g.provider == entry.provider && g.model == entry.model)
        {
            Some(index) => index,
            None => {
                grouped.push(TokenUsage {
                    provider: entry.provider.clone(),
                    model: entry.model.clone(),
                    ..Default::default()
                });
                grouped.len() - 1
            }
        };

        let target = &mut grouped[index];
        add_into(&mut target.input_tokens, entry.input_tokens);
        add_into(&mut target.output_tokens, entry.output_tokens);
        add_into(&mut target.total_tokens, entry.total_tokens);
        add_into(&mut target.reasoning_tokens, entry.reasoning_tokens);
        add_into(&mut target.cached_input_tokens, entry.cached_input_tokens);
    }

    grouped
}

/// Adds `value` into `target`, leaving `target` untouched when nothing was
/// reported. Saturating, so a hostile producer cannot panic the aggregation.
fn add_into(target: &mut Option<u64>, value: Option<u64>) {
    if let Some(value) = value {
        *target = Some(target.unwrap_or(0).saturating_add(value));
    }
}
