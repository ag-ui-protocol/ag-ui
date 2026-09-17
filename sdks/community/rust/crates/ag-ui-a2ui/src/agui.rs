//! Interop with [`ag_ui`](https://docs.rs/ag-ui/0.4.2/ag_ui/index.html) (feature `ag-ui`).
//!
//! A2UI is transport-agnostic and this crate keeps it that way — nothing below
//! this module knows what AG-UI is. What lives here is the small amount of
//! glue an agent hosted on AG-UI would otherwise write by hand, twice:
//!
//! - [`HistoryMessage`] from an [`ag_ui::Message`](https://docs.rs/ag-ui/0.4.2/ag_ui/message/enum.Message.html), so the surface-recovery
//!   scan can read an AG-UI thread directly.
//! - [`find_prior_surface_in`], the same scan without the mapping step.
//! - [`ag_ui::Tool`](https://docs.rs/ag-ui/0.4.2/ag_ui/tool/struct.Tool.html) from a [`ToolDefinition`], so the toolkit's two tool
//!   definitions can be offered on a run.
//!
//! Turn the feature off to use A2UI standalone over A2A or MCP; the dependency
//! on `ag-ui-core` goes with it.

use ag_ui::{Message, Tool};
use serde_json::Value;

use crate::toolkit::history::{HistoryMessage, PriorSurface, find_prior_surface};
use crate::toolkit::tools::ToolDefinition;

/// Maps an AG-UI message onto the toolkit's transport-neutral history entry.
///
/// Text goes to `content` and structured payloads to `data`, which is the split
/// [`crate::toolkit::history`] scans on. A user's multimodal parts are flattened
/// to their text: an A2UI envelope is never an image.
impl From<&Message> for HistoryMessage {
    fn from(message: &Message) -> Self {
        let role = message.role().as_str();
        match message {
            Message::Developer(m) => Self::text(role, m.content.clone()),
            Message::System(m) => Self::text(role, m.content.clone()),
            Message::Assistant(m) => Self::text(role, m.content.clone().unwrap_or_default()),
            Message::User(m) => Self::text(role, m.content.to_text()),
            Message::Tool(m) => Self::text(role, m.content.clone()),
            Message::Reasoning(m) => Self::text(role, m.content.clone()),
            Message::Activity(m) => Self::data(role, Value::Object(m.content.clone())),
        }
    }
}

/// Offers a toolkit tool definition on an AG-UI run.
impl From<ToolDefinition> for Tool {
    fn from(definition: ToolDefinition) -> Self {
        Self::new(
            definition.name,
            definition.description,
            definition.parameters,
        )
    }
}

/// [`find_prior_surface`] over an AG-UI conversation.
///
/// The agent stores nothing between runs, so "what is the user looking at" comes
/// from the thread the client sent: this replays the A2UI operations already in
/// it and reports the surface they built.
///
/// ```
/// use ag_ui_a2ui::agui::find_prior_surface_in;
/// use ag_ui_a2ui::toolkit::envelope::wrap_as_operations_envelope;
/// use ag_ui_a2ui::{AgentMessage, Component};
/// use ag_ui::Message;
/// use serde_json::json;
///
/// let rendered = wrap_as_operations_envelope(&[
///     AgentMessage::create_surface("board", "basic"),
///     AgentMessage::update_components(
///         "board",
///         vec![Component::new("root", "Text").with("text", json!("hello"))],
///     ),
/// ])?;
///
/// let thread = [
///     Message::user("m-1", "show me the board"),
///     Message::tool("m-2", "call-1", rendered),
/// ];
///
/// let prior = find_prior_surface_in(&thread).expect("the thread rendered a surface");
/// assert_eq!(prior.surface_id, "board");
/// assert_eq!(prior.catalog_id.as_deref(), Some("basic"));
/// assert!(prior.component("root").is_some());
/// # Ok::<(), ag_ui_a2ui::Error>(())
/// ```
pub fn find_prior_surface_in(messages: &[Message]) -> Option<PriorSurface> {
    let history: Vec<HistoryMessage> = messages.iter().map(HistoryMessage::from).collect();
    find_prior_surface(&history)
}

/// Sends a fully validated batch through this integration's `a2ui_operations`
/// tool-result envelope. Enqueue success does not acknowledge renderer application.
#[cfg(feature = "ag-ui-server")]
pub trait A2uiRunContextExt {
    /// Emits one render tool call and its result. Never automatically retries a batch.
    fn send_a2ui(&mut self, surface: &crate::ValidatedSurface) -> ag_ui::server::Result<()>;
}
#[cfg(feature = "ag-ui-server")]
impl<S: ag_ui::server::AgentState> A2uiRunContextExt for ag_ui::server::RunContext<S> {
    fn send_a2ui(&mut self, surface: &crate::ValidatedSurface) -> ag_ui::server::Result<()> {
        let envelope = crate::toolkit::envelope::wrap_as_operations_envelope(surface.operations())
            .map_err(ag_ui::server::Error::agent)?;
        let mut call = self.tool_call(crate::constants::RENDER_A2UI_TOOL_NAME)?;
        call.args_json(&serde_json::json!({"surfaceId":surface.surface_id()}))?;
        call.result(envelope)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::toolkit::envelope::wrap_as_operations_envelope;
    use crate::toolkit::tools::{generate_a2ui_tool, render_a2ui_tool};
    use crate::{AgentMessage, Component};
    use ag_ui::{ActivityMessage, InputContent, JsonObject, UserContent};
    use serde_json::json;

    #[test]
    fn every_role_maps_to_the_field_the_scan_reads() {
        let mut activity = JsonObject::new();
        activity.insert("step".into(), json!("searching"));

        let cases: Vec<(Message, &str, &str, bool)> = vec![
            (
                Message::system("m", "be brief"),
                "system",
                "be brief",
                false,
            ),
            (
                Message::developer("m", "internal"),
                "developer",
                "internal",
                false,
            ),
            (
                Message::assistant("m", "on it"),
                "assistant",
                "on it",
                false,
            ),
            (Message::user("m", "hello"), "user", "hello", false),
            (
                Message::tool("m", "call-1", "{\"ok\":true}"),
                "tool",
                "{\"ok\":true}",
                false,
            ),
            (
                Message::Activity(ActivityMessage {
                    id: "m".into(),
                    activity_type: "web_search".into(),
                    content: activity,
                    ..Default::default()
                }),
                "activity",
                "",
                true,
            ),
        ];

        for (message, role, content, has_data) in cases {
            let entry = HistoryMessage::from(&message);
            assert_eq!(entry.role, role);
            assert_eq!(entry.content, content, "content of {role}");
            assert_eq!(entry.data.is_some(), has_data, "data of {role}");
        }
    }

    #[test]
    fn a_multimodal_turn_contributes_its_text() {
        let message = Message::user(
            "m",
            UserContent::from(vec![
                InputContent::text("look at this"),
                InputContent::text("and this"),
            ]),
        );
        assert_eq!(
            HistoryMessage::from(&message).content,
            "look at this\nand this"
        );
    }

    #[test]
    fn a_thread_with_no_a2ui_recovers_nothing() {
        let thread = [
            Message::user("m-1", "hello"),
            Message::assistant("m-2", "hi there"),
        ];
        assert!(find_prior_surface_in(&thread).is_none());
    }

    #[test]
    fn a_deleted_surface_is_recovered_as_deleted() {
        let envelope = wrap_as_operations_envelope(&[
            AgentMessage::create_surface("board", "basic"),
            AgentMessage::update_components(
                "board",
                vec![Component::new("root", "Text").with("text", json!("hi"))],
            ),
            AgentMessage::delete_surface("board"),
        ])
        .expect("operations serialize");

        let thread = [Message::tool("m-1", "call-1", envelope)];
        let prior = find_prior_surface_in(&thread).expect("the surface was rendered");
        assert!(prior.deleted);
    }

    #[test]
    fn both_toolkit_tools_convert_into_offerable_tools() {
        for definition in [generate_a2ui_tool(), render_a2ui_tool(None)] {
            let name = definition.name;
            let tool = Tool::from(definition);
            assert_eq!(tool.name, name);
            assert!(!tool.description.is_empty());
            assert_eq!(tool.parameters["type"], "object");
        }
    }
}
