use std::error::Error;
use std::fmt::{Debug, Display, Formatter};
use std::sync::Arc;
use async_trait::async_trait;
use log::info;
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use ag_ui_client::agent::{AgentError, AgentStateMutation, RunAgentParams};
use ag_ui_client::{Agent, HttpAgent};
use ag_ui_client::subscriber::{AgentSubscriber, AgentSubscriberParams};
use ag_ui_core::{AgentState, FwdProps, JsonValue};
use ag_ui_core::event::{StateDeltaEvent, StateSnapshotEvent};
use ag_ui_core::types::ids::MessageId;
use ag_ui_core::types::message::Message;

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, Hash)]
pub enum SkillLevel {
	#[default]
	Beginner,
	Intermediate,
	Advanced,
}

impl Display for SkillLevel {
	fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
		write!(f, "{:?}", self)
	}
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Hash)]
pub enum SpecialPreferences {
	#[serde(rename = "High Protein")]
	HighProtein,
	#[serde(rename = "Low Carb")]
	LowCarb,
	Spicy,
	#[serde(rename = "Budget-Friendly")]
	BudgetFriendly,
	#[serde(rename = "One-Pot Meal")]
	OnePotMeal,
	Vegetarian,
	Vegan,
}

impl Display for SpecialPreferences {
	fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
		write!(f, "{:?}", self)
	}
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Hash, Default)]
pub enum CookingTime {
	#[default]
	#[serde(rename = "5 min")]
	FiveMin,
	#[serde(rename = "15 min")]
	FifteenMin,
	#[serde(rename = "30 min")]
	ThirtyMin,
	#[serde(rename = "45 min")]
	FortyFiveMin,
	#[serde(rename = "60+ min")]
	SixtyPlusMin,
}

impl Display for CookingTime {
	fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
		write!(f, "{:?}", self)
	}
}

fn default_icon() -> String {
	"ingredient".to_string()
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Ingredient {
	#[serde(default = "default_icon")]
	pub icon: String,
	pub name: String,
	pub amount: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Recipe {
	#[serde(default)]
	pub skill_level: SkillLevel,
	#[serde(default)]
	pub special_preferences: Vec<SpecialPreferences>,
	#[serde(default)]
	pub cooking_time: CookingTime,
	#[serde(default)]
	pub ingredients: Vec<Ingredient>,
	#[serde(default)]
	pub instructions: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct RecipeSnapshot {
	#[serde(default)]
	pub recipe: Recipe,
}

impl AgentState for RecipeSnapshot {}

pub struct RecipeSubscriber;

impl RecipeSubscriber {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl<FwdPropsT> AgentSubscriber<RecipeSnapshot, FwdPropsT> for RecipeSubscriber
where
    FwdPropsT: FwdProps + Debug,
{
	async fn on_state_snapshot_event(
		&self,
		event: &StateSnapshotEvent<RecipeSnapshot>,
		_params: AgentSubscriberParams<'async_trait, RecipeSnapshot, FwdPropsT>,
	) -> Result<AgentStateMutation<RecipeSnapshot>, AgentError> {
		info!("Received state snapshot update: {:#?}", event.snapshot);
		Ok(AgentStateMutation::default())
	}

	async fn on_state_delta_event(&self, event: &StateDeltaEvent, _params: AgentSubscriberParams<'async_trait, RecipeSnapshot, FwdPropsT>) -> Result<AgentStateMutation<RecipeSnapshot>, AgentError> {
		info!("Received state delta event {:#?}", event.delta);
		Ok(AgentStateMutation::default())
	}

	async fn on_state_changed(&self, params: AgentSubscriberParams<'async_trait, RecipeSnapshot, FwdPropsT>) -> Result<(), AgentError> {
		info!("Received state changed event: {:?}", params.state);
		Ok(())
	}
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
	env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let base_url = Url::parse("http://127.0.0.1:3001/")?;
    let headers = HeaderMap::new();

    // Create the HTTP agent
    let agent = HttpAgent::new(base_url, headers);

	let subscriber = RecipeSubscriber::new();

	// Create run parameters
    let params = RunAgentParams {
        run_id: None,
        tools: None,
        context: None,
        forwarded_props: Some(JsonValue::Null),
        messages: vec![Message::User {
            id: MessageId::random(),
            content: "I want to bake a loaf of bread, can you give me a recipe?".into(),
            name: None,
        }],
        state: RecipeSnapshot::default(),
    };

	info!("Starting agent run with input: {:#?}", params);

	let result = agent.run_agent(&params, vec![Arc::new(subscriber)]).await?;

	info!("Agent run finished. Final result: {:#?}", result);

	Ok(())
}