//! The validate-and-retry loop around a generating model.
//!
//! Prompted generation is not schema-constrained, so a model will sometimes
//! return a surface that does not hold together: a child id it never defined, a
//! missing root, a loop. That is recoverable — the validator says exactly what
//! is wrong in words the model can act on, so the fix is to hand the errors back
//! and ask again.
//!
//! [`generate_with_recovery`] runs that loop up to
//! [`MAX_A2UI_ATTEMPTS`] times, appending
//! the formatted errors to the prompt between attempts and reporting each step
//! under the [`A2UI_RECOVERY_ACTIVITY_TYPE`] activity type so a caller can show
//! progress rather than a stall.
//!
//! Both synchronous and asynchronous callbacks are supported. The async form
//! takes an owned prompt and awaits each generation without selecting an executor.
//!
//! ```
//! use ag_ui_a2ui::catalog::Catalog;
//! use ag_ui_a2ui::toolkit::recovery::{generate_with_recovery, RecoveryOptions};
//!
//! fn response(components: &str) -> String {
//!     format!(
//!         r#"<a2ui-json>[
//!              {{"version":"v0.9","createSurface":{{"surfaceId":"s","catalogId":"c"}}}},
//!              {{"version":"v0.9","updateComponents":{{"surfaceId":"s","components":{components}}}}}
//!            ]</a2ui-json>"#
//!     )
//! }
//!
//! let catalog = Catalog::basic();
//! let mut attempt = 0;
//! let outcome = generate_with_recovery(
//!     "build a greeting card",
//!     &catalog,
//!     &RecoveryOptions::default(),
//!     |prompt, _n| {
//!         attempt += 1;
//!         Ok(if attempt == 1 {
//!             // First try references a component that was never defined.
//!             assert!(!prompt.contains("Correction required"));
//!             response(r#"[{"id":"root","component":"Card","child":"missing"}]"#)
//!         } else {
//!             // The retry prompt now carries the validator's complaint.
//!             assert!(prompt.contains("unresolved_child"));
//!             response(r#"[{"id":"root","component":"Text","text":"hi"}]"#)
//!         })
//!     },
//!     |_activity| {},
//! )
//! .unwrap();
//!
//! assert_eq!(outcome.attempts, 2);
//! assert_eq!(outcome.components.len(), 1);
//! ```

use serde_json::Value;

use crate::catalog::Catalog;
use crate::constants::{A2UI_RECOVERY_ACTIVITY_TYPE, MAX_A2UI_ATTEMPTS};
use crate::error::{Error, Result, ValidationErrors};
use crate::message::{AgentMessage, Component};
use crate::toolkit::parser::parse_response;
use crate::toolkit::prompt::augment_prompt_with_errors;
use crate::validate::{ValidateOptions, ValidationError, Validator};

/// How the recovery loop should behave.
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryOptions {
    /// Total attempts before giving up. Defaults to [`MAX_A2UI_ATTEMPTS`].
    pub max_attempts: u32,
    /// The contract each attempt is held to.
    pub validate: ValidateOptions,
    /// Explicit prior renderer state for incremental updates.
    pub prior: Option<crate::surface::SurfaceStore>,
}

impl Default for RecoveryOptions {
    fn default() -> Self {
        Self {
            max_attempts: MAX_A2UI_ATTEMPTS,
            validate: ValidateOptions::full_surface(),
            prior: None,
        }
    }
}

impl RecoveryOptions {
    /// Semantic options for editing. Set `prior` to the observed surface store;
    /// an update stream without prior state is rejected.
    pub fn for_update() -> Self {
        Self {
            validate: ValidateOptions::incremental_update(),
            ..Self::default()
        }
    }
}

/// What happened on one attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryActivity {
    /// Always [`A2UI_RECOVERY_ACTIVITY_TYPE`], so callers can route on it.
    pub activity_type: &'static str,
    /// 1-based attempt number.
    pub attempt: u32,
    /// Total attempts allowed.
    pub max_attempts: u32,
    /// How the attempt ended.
    pub status: RecoveryStatus,
    /// A sentence describing this step, suitable for showing to a user.
    pub message: String,
    /// Validation failures from this attempt, empty on success.
    pub errors: Vec<ValidationError>,
}

/// How one attempt ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryStatus {
    /// The model is being asked to generate.
    Started,
    /// The output validated; the loop is done.
    Succeeded,
    /// The output failed validation and another attempt follows.
    Retrying,
    /// The attempts are used up.
    Failed,
}

impl RecoveryStatus {
    /// The wire string for this status.
    pub fn as_str(self) -> &'static str {
        match self {
            RecoveryStatus::Started => "started",
            RecoveryStatus::Succeeded => "succeeded",
            RecoveryStatus::Retrying => "retrying",
            RecoveryStatus::Failed => "failed",
        }
    }
}

/// A surface that survived validation.
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveredSurface {
    /// The operations the model produced, in order.
    pub operations: Vec<AgentMessage>,
    /// The components those operations define, folded together.
    pub components: Vec<Component>,
    /// The data model those operations build.
    pub data_model: crate::DataModel,
    /// Conversational text the model wrote around the A2UI blocks.
    pub text: String,
    /// How many attempts it took, 1 when the first try was clean.
    pub attempts: u32,
}

/// Generates a surface, retrying with the validator's complaints on failure.
///
/// `generate` receives the prompt for this attempt and the 1-based attempt
/// number, and returns the model's raw response. `on_activity` is called for
/// every step, including the initial start.
///
/// # Errors
///
/// Returns [`Error::RecoveryExhausted`] when every attempt fails validation, or
/// whatever error `generate` itself returns. A response that cannot be parsed at
/// all is treated as a failed attempt and retried, since that is exactly the
/// case retrying tends to fix.
pub fn generate_with_recovery(
    prompt: &str,
    catalog: &Catalog,
    options: &RecoveryOptions,
    mut generate: impl FnMut(&str, u32) -> Result<String>,
    mut on_activity: impl FnMut(&RecoveryActivity),
) -> Result<RecoveredSurface> {
    let max_attempts = options.max_attempts.max(1);
    let validator = Validator::with_options(catalog, options.validate.clone());
    let mut errors: Vec<ValidationError> = Vec::new();

    for attempt in 1..=max_attempts {
        let attempt_prompt = augment_prompt_with_errors(prompt, &errors);
        on_activity(&RecoveryActivity {
            activity_type: A2UI_RECOVERY_ACTIVITY_TYPE,
            attempt,
            max_attempts,
            status: RecoveryStatus::Started,
            message: if attempt == 1 {
                "Generating the A2UI surface.".to_string()
            } else {
                format!(
                    "Retrying the A2UI surface after {} validation error(s).",
                    errors.len()
                )
            },
            errors: Vec::new(),
        });

        let response = generate(&attempt_prompt, attempt)?;

        match interpret(&response, &validator, options.prior.as_ref()) {
            Ok(mut surface) => {
                surface.attempts = attempt;
                on_activity(&RecoveryActivity {
                    activity_type: A2UI_RECOVERY_ACTIVITY_TYPE,
                    attempt,
                    max_attempts,
                    status: RecoveryStatus::Succeeded,
                    message: format!(
                        "A2UI surface validated on attempt {attempt} with {} component(s).",
                        surface.components.len()
                    ),
                    errors: Vec::new(),
                });
                return Ok(surface);
            }
            Err(attempt_errors) => {
                errors = attempt_errors;
                let last = attempt == max_attempts;
                on_activity(&RecoveryActivity {
                    activity_type: A2UI_RECOVERY_ACTIVITY_TYPE,
                    attempt,
                    max_attempts,
                    status: if last {
                        RecoveryStatus::Failed
                    } else {
                        RecoveryStatus::Retrying
                    },
                    message: if last {
                        format!(
                            "Gave up after {max_attempts} attempt(s); {} error(s) remain.",
                            errors.len()
                        )
                    } else {
                        format!(
                            "Attempt {attempt} produced {} validation error(s); retrying.",
                            errors.len()
                        )
                    },
                    errors: errors.clone(),
                });
            }
        }
    }

    Err(Error::RecoveryExhausted {
        attempts: max_attempts,
        last: ValidationErrors(errors),
    })
}

/// Async form of [`generate_with_recovery`], with an owned prompt per attempt.
/// No executor or Send bound is imposed; provider failures are returned immediately.
pub async fn generate_with_recovery_async<F, Fut>(
    prompt: &str,
    catalog: &Catalog,
    options: &RecoveryOptions,
    mut generate: F,
    mut on_activity: impl FnMut(&RecoveryActivity),
) -> Result<RecoveredSurface>
where
    F: FnMut(String, u32) -> Fut,
    Fut: std::future::Future<Output = Result<String>>,
{
    let max_attempts = options.max_attempts.max(1);
    let validator = Validator::with_options(catalog, options.validate.clone());
    let mut errors: Vec<ValidationError> = Vec::new();

    for attempt in 1..=max_attempts {
        let attempt_prompt = augment_prompt_with_errors(prompt, &errors);
        on_activity(&RecoveryActivity {
            activity_type: A2UI_RECOVERY_ACTIVITY_TYPE,
            attempt,
            max_attempts,
            status: RecoveryStatus::Started,
            message: if attempt == 1 {
                "Generating the A2UI surface.".to_string()
            } else {
                format!(
                    "Retrying the A2UI surface after {} validation error(s).",
                    errors.len()
                )
            },
            errors: Vec::new(),
        });

        let response = generate(attempt_prompt, attempt).await?;

        match interpret(&response, &validator, options.prior.as_ref()) {
            Ok(mut surface) => {
                surface.attempts = attempt;
                on_activity(&RecoveryActivity {
                    activity_type: A2UI_RECOVERY_ACTIVITY_TYPE,
                    attempt,
                    max_attempts,
                    status: RecoveryStatus::Succeeded,
                    message: format!(
                        "A2UI surface validated on attempt {attempt} with {} component(s).",
                        surface.components.len()
                    ),
                    errors: Vec::new(),
                });
                return Ok(surface);
            }
            Err(attempt_errors) => {
                errors = attempt_errors;
                let last = attempt == max_attempts;
                on_activity(&RecoveryActivity {
                    activity_type: A2UI_RECOVERY_ACTIVITY_TYPE,
                    attempt,
                    max_attempts,
                    status: if last {
                        RecoveryStatus::Failed
                    } else {
                        RecoveryStatus::Retrying
                    },
                    message: if last {
                        format!(
                            "Gave up after {max_attempts} attempt(s); {} error(s) remain.",
                            errors.len()
                        )
                    } else {
                        format!(
                            "Attempt {attempt} produced {} validation error(s); retrying.",
                            errors.len()
                        )
                    },
                    errors: errors.clone(),
                });
            }
        }
    }

    Err(Error::RecoveryExhausted {
        attempts: max_attempts,
        last: ValidationErrors(errors),
    })
}

/// Parses and validates one model response.
///
/// A parse failure is reported as a validation error rather than a hard error,
/// so the loop treats "the model wrote something unparseable" the same way it
/// treats "the model wrote something inconsistent": tell it, and ask again.
///
/// Response-level failures — unparseable output, or a message that matches no
/// envelope — are reported as [`ErrorCode::EmptyComponents`] at path `response`,
/// since the outcome is the same in each case: no components could be extracted.
/// The error-code set is a fixed contract, so no new code is invented for them.
///
/// [`ErrorCode::EmptyComponents`]: crate::validate::ErrorCode::EmptyComponents
fn interpret(
    response: &str,
    validator: &Validator<'_>,
    prior: Option<&crate::surface::SurfaceStore>,
) -> std::result::Result<RecoveredSurface, Vec<ValidationError>> {
    let parts = match parse_response(response) {
        Ok(parts) => parts,
        Err(error) => {
            return Err(vec![ValidationError::new(
                crate::validate::ErrorCode::EmptyComponents,
                "response",
                format!(
                    "{error} Return the A2UI messages as a JSON array wrapped in the required \
                     tags."
                ),
            )]);
        }
    };

    let mut operations: Vec<AgentMessage> = Vec::new();
    let mut text_parts: Vec<String> = Vec::new();
    for part in &parts {
        if !part.text.is_empty() {
            text_parts.push(part.text.clone());
        }
        let Some(messages) = &part.a2ui else { continue };
        for message in messages {
            match serde_json::from_value::<AgentMessage>(message.clone()) {
                Ok(operation) => operations.push(operation),
                Err(error) => {
                    return Err(vec![ValidationError::new(
                        crate::validate::ErrorCode::EmptyComponents,
                        "response",
                        format!(
                            "A message did not match any A2UI envelope ({error}). Each message \
                             must be an object with a 'version' and exactly one of createSurface, \
                             updateComponents, updateDataModel or deleteSurface."
                        ),
                    )]);
                }
            }
        }
    }

    let raw: Vec<Value> = parts
        .iter()
        .filter_map(|part| part.a2ui.as_ref())
        .flatten()
        .cloned()
        .collect();
    let store = if let Some(prior) = prior {
        validator
            .validate_updates(prior, &operations)
            .map_err(|error| {
                vec![ValidationError::new(
                    crate::ErrorCode::InvalidValue,
                    "response",
                    error.to_string(),
                )]
            })?
    } else {
        let report = validator.validate_json_messages(&raw);
        if !report.is_valid() {
            return Err(report.errors);
        }
        let mut store = crate::surface::SurfaceStore::new();
        for operation in &operations {
            store.apply(operation).map_err(|error| {
                vec![ValidationError::new(
                    crate::ErrorCode::InvalidValue,
                    "response",
                    error.to_string(),
                )]
            })?;
        }
        store
    };
    let surface = store.surfaces().find(|s| !s.deleted);
    let components = surface.map_or_else(Vec::new, |s| s.components.clone());
    let data_model = surface.map_or_else(crate::DataModel::default, |s| s.data_model.clone());

    Ok(RecoveredSurface {
        operations,
        components,
        data_model,
        text: text_parts.join("\n"),
        attempts: 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wrap(components: Value) -> String {
        format!(
            "<a2ui-json>[{{\"version\":\"v0.9\",\"createSurface\":{{\"surfaceId\":\"s\",\
             \"catalogId\":\"c\"}}}},{{\"version\":\"v0.9\",\"updateComponents\":\
             {{\"surfaceId\":\"s\",\"components\":{components}}}}}]</a2ui-json>"
        )
    }

    fn good() -> String {
        wrap(json!([{"id": "root", "component": "Text", "text": "hi"}]))
    }

    fn bad() -> String {
        wrap(json!([{"id": "root", "component": "Card", "child": "nope"}]))
    }

    #[test]
    fn a_clean_first_attempt_does_not_retry() {
        let catalog = Catalog::basic();
        let mut calls = 0;
        let mut activities = Vec::new();
        let surface = generate_with_recovery(
            "prompt",
            &catalog,
            &RecoveryOptions::default(),
            |_, _| {
                calls += 1;
                Ok(good())
            },
            |activity| activities.push(activity.clone()),
        )
        .unwrap();

        assert_eq!(calls, 1);
        assert_eq!(surface.attempts, 1);
        assert_eq!(surface.components.len(), 1);
        assert_eq!(surface.operations.len(), 2);
        assert_eq!(
            activities.iter().map(|a| a.status).collect::<Vec<_>>(),
            vec![RecoveryStatus::Started, RecoveryStatus::Succeeded]
        );
        assert!(
            activities
                .iter()
                .all(|a| a.activity_type == A2UI_RECOVERY_ACTIVITY_TYPE)
        );
    }

    #[test]
    fn a_failed_attempt_puts_the_errors_in_the_next_prompt() {
        let catalog = Catalog::basic();
        let mut prompts = Vec::new();
        let mut calls = 0;
        let surface = generate_with_recovery(
            "base prompt",
            &catalog,
            &RecoveryOptions::default(),
            |prompt, attempt| {
                prompts.push(prompt.to_string());
                calls += 1;
                assert_eq!(attempt, calls);
                Ok(if calls == 1 { bad() } else { good() })
            },
            |_| {},
        )
        .unwrap();

        assert_eq!(surface.attempts, 2);
        assert_eq!(prompts.len(), 2);
        assert!(!prompts[0].contains("Correction required"));
        assert!(prompts[1].contains("Correction required"));
        assert!(prompts[1].contains("unresolved_child"));
        assert!(prompts[1].contains("components[0].child"));
    }

    #[test]
    fn three_failures_exhaust_the_loop_and_report_the_last_errors() {
        let catalog = Catalog::basic();
        let mut calls = 0;
        let mut activities = Vec::new();
        let error = generate_with_recovery(
            "prompt",
            &catalog,
            &RecoveryOptions::default(),
            |_, _| {
                calls += 1;
                Ok(bad())
            },
            |activity| activities.push(activity.clone()),
        )
        .unwrap_err();

        assert_eq!(calls, MAX_A2UI_ATTEMPTS);
        let Error::RecoveryExhausted { attempts, last } = error else {
            panic!("expected RecoveryExhausted");
        };
        assert_eq!(attempts, MAX_A2UI_ATTEMPTS);
        assert!(last.to_string().contains("unresolved_child"));

        let statuses: Vec<_> = activities.iter().map(|a| a.status).collect();
        assert_eq!(
            statuses,
            vec![
                RecoveryStatus::Started,
                RecoveryStatus::Retrying,
                RecoveryStatus::Started,
                RecoveryStatus::Retrying,
                RecoveryStatus::Started,
                RecoveryStatus::Failed,
            ]
        );
    }

    #[test]
    fn unparseable_output_is_retried_rather_than_raised() {
        let catalog = Catalog::basic();
        let mut calls = 0;
        let surface = generate_with_recovery(
            "prompt",
            &catalog,
            &RecoveryOptions::default(),
            |_, _| {
                calls += 1;
                Ok(if calls == 1 {
                    "I'm afraid I can't do that.".to_string()
                } else {
                    good()
                })
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(surface.attempts, 2);
    }

    #[test]
    fn a_generator_error_stops_the_loop_immediately() {
        let catalog = Catalog::basic();
        let mut calls = 0;
        let error = generate_with_recovery(
            "prompt",
            &catalog,
            &RecoveryOptions::default(),
            |_, _| {
                calls += 1;
                Err(Error::parse("model is offline"))
            },
            |_| {},
        )
        .unwrap_err();
        assert_eq!(calls, 1);
        assert!(matches!(error, Error::Parse(_)));
    }

    #[test]
    fn conversational_text_and_data_survive_the_loop() {
        let catalog = Catalog::basic();
        let response = "Here is your card.\n<a2ui-json>[{\"version\":\"v0.9\",\"createSurface\":\
             {\"surfaceId\":\"s\",\"catalogId\":\"c\"}},{\"version\":\"v0.9\",\
             \"updateComponents\":{\"surfaceId\":\"s\",\"components\":[{\"id\":\"root\",\
             \"component\":\"Text\",\"text\":{\"path\":\"/name\"}}]}},{\"version\":\
             \"v0.9\",\"updateDataModel\":{\"surfaceId\":\"s\",\"path\":\"/name\",\
             \"value\":\"Ada\"}}]</a2ui-json>\nAnything else?";
        let surface = generate_with_recovery(
            "prompt",
            &catalog,
            &RecoveryOptions::default(),
            |_, _| Ok(response.to_string()),
            |_| {},
        )
        .unwrap();
        assert_eq!(surface.text, "Here is your card.\nAnything else?");
        assert_eq!(surface.data_model, json!({"name": "Ada"}));
    }

    #[test]
    fn incremental_recovery_without_prior_state_is_rejected() {
        let catalog = Catalog::basic();
        let response = "<a2ui-json>[{\"version\":\"v0.9\",\"updateComponents\":\
                        {\"surfaceId\":\"s\",\"components\":[{\"id\":\"label\",\
                        \"component\":\"Text\",\"text\":\"updated\"}]}}]</a2ui-json>";
        let surface = generate_with_recovery(
            "prompt",
            &catalog,
            &RecoveryOptions::for_update(),
            |_, _| Ok(response.to_string()),
            |_| {},
        )
        .unwrap_err();
        assert!(matches!(surface, Error::RecoveryExhausted { .. }));
    }

    #[test]
    fn max_attempts_is_honoured_and_never_zero() {
        let catalog = Catalog::basic();
        let mut calls = 0;
        let options = RecoveryOptions {
            max_attempts: 0,
            ..RecoveryOptions::default()
        };
        let _ = generate_with_recovery(
            "prompt",
            &catalog,
            &options,
            |_, _| {
                calls += 1;
                Ok(bad())
            },
            |_| {},
        );
        assert_eq!(calls, 1, "a zero budget must still make one attempt");
    }

    #[test]
    fn statuses_have_stable_wire_strings() {
        assert_eq!(RecoveryStatus::Started.as_str(), "started");
        assert_eq!(RecoveryStatus::Succeeded.as_str(), "succeeded");
        assert_eq!(RecoveryStatus::Retrying.as_str(), "retrying");
        assert_eq!(RecoveryStatus::Failed.as_str(), "failed");
    }
}
