pub mod error;
pub mod event;
pub mod types;

use serde::{Deserialize, Serialize};
pub use error::{AguiError, Result};
/// Re-export to ensure the same type is used
pub use serde_json::Value as JsonValue;

pub trait State: 'static + Clone + Send + Sync + for<'de> Deserialize<'de> + Serialize {}
impl State for JsonValue {}

pub trait FwdProps: 'static + Clone + Send + Sync + for<'de> Deserialize<'de> + Serialize {}
impl FwdProps for JsonValue {}

