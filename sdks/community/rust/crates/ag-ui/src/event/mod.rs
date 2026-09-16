//! The AG-UI event stream.
//!
//! An agent run is a sequence of these events. [`Event`] is the closed union of
//! all of them, tagged on the wire by a `type` field holding a
//! SCREAMING_SNAKE_CASE name:
//!
//! ```
//! # use ag_ui::{Event, EventType};
//! let event = Event::text_message_content("msg-1", "Hello");
//! assert_eq!(event.event_type(), EventType::TextMessageContent);
//! assert_eq!(
//!     serde_json::to_string(&event).unwrap(),
//!     r#"{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"Hello"}"#
//! );
//! ```
//!
//! Every event also carries the optional [`BaseEvent`] fields — a timestamp,
//! the provider event it was translated from, and [`metadata`](crate::metadata)
//! — flattened into the same JSON object. Most events additionally accept an
//! optional `subagentRunId` saying which subagent produced them; see
//! [`subagent`].

// The THINKING_* events are deprecated but still part of the protocol, so this
// module has to name them constantly — in the union, in `event_type()`, in the
// factories. Downstream users still get the warnings; we just do not warn at
// ourselves for implementing the spec as written.
#![allow(deprecated)]

pub mod activity;
pub mod factories;
pub mod lifecycle;
pub mod reasoning;
pub mod special;
pub mod state;
pub mod subagent;
pub mod text;
pub mod tool;

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::JsonObject;
use crate::error::{Error, Result};
use crate::ids::SubagentRunId;

pub use activity::{ActivityDeltaEvent, ActivitySnapshotEvent};
pub use lifecycle::{
    RunErrorEvent, RunFinishedEvent, RunStartedEvent, StepFinishedEvent, StepStartedEvent,
};
pub use reasoning::{
    ReasoningEncryptedValueEvent, ReasoningEncryptedValueSubtype, ReasoningEndEvent,
    ReasoningMessageChunkEvent, ReasoningMessageContentEvent, ReasoningMessageEndEvent,
    ReasoningMessageStartEvent, ReasoningRole, ReasoningStartEvent, ThinkingEndEvent,
    ThinkingStartEvent, ThinkingTextMessageContentEvent, ThinkingTextMessageEndEvent,
    ThinkingTextMessageStartEvent,
};
pub use special::{CustomEvent, RawEvent};
pub use state::{MessagesSnapshotEvent, StateDeltaEvent, StateSnapshotEvent};
pub use subagent::{
    SubagentErrorEvent, SubagentFinishedEvent, SubagentOutcome, SubagentStartedEvent,
};
pub use text::{
    TextMessageChunkEvent, TextMessageContentEvent, TextMessageEndEvent, TextMessageRole,
    TextMessageStartEvent,
};
pub use tool::{
    ToolCallArgsEvent, ToolCallChunkEvent, ToolCallEndEvent, ToolCallResultEvent,
    ToolCallStartEvent, ToolResultRole,
};

/// The fields every event may carry, flattened into the event's own JSON
/// object rather than nested under a key.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct BaseEvent {
    /// When the event was produced, in milliseconds since the Unix epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    /// The provider event this was translated from, for debugging.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_event: Option<Value>,
    /// Extra information, open by key. Absent or an object — a JSON `null` in
    /// place of the object is rejected. See [`crate::metadata`] for the
    /// reserved key and how consumers merge it into messages.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(
        feature = "schemars",
        schemars(with = "Option<std::collections::BTreeMap<String, serde_json::Value>>")
    )]
    #[cfg_attr(feature = "utoipa", schema(value_type = Option<Object>))]
    pub metadata: Option<JsonObject>,
}

impl BaseEvent {
    /// An empty base — no timestamp, no raw event, no metadata.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether every field is absent, in which case the base contributes
    /// nothing to the serialized event.
    pub const fn is_empty(&self) -> bool {
        self.timestamp.is_none() && self.raw_event.is_none() && self.metadata.is_none()
    }
}

macro_rules! define_events {
    ($(
        $(#[$meta:meta])*
        $variant:ident($payload:ty) => $tag:literal,
    )*) => {
        /// One event in an AG-UI stream.
        ///
        /// Serializes as the payload's fields plus a `type` discriminator, so
        /// there is no nesting on the wire.
        ///
        /// # Exhaustive on purpose
        ///
        /// This enum is deliberately *not* `#[non_exhaustive]`, unlike every
        /// error type in this workspace. A new protocol event **should** be a
        /// compile error where you match on events: that is what a typed SDK
        /// buys you over `serde_json::Value`, and the alternative — a `_` arm
        /// in every consumer — is exactly how the previous Rust SDK came to be
        /// missing eight event types without anyone noticing.
        ///
        /// The consequence is that adding an event is a major version of this
        /// crate. That is the intended price; see `docs/DESIGN.md`.
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
        #[serde(tag = "type")]
        #[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
        #[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
        pub enum Event {
            $(
                $(#[$meta])*
                #[serde(rename = $tag)]
                $variant($payload),
            )*
        }

        /// The `type` discriminator of an [`Event`], on its own.
        ///
        /// Useful for routing and filtering without matching the payload.
        /// Exhaustive for the same reason [`Event`] is, and
        /// [`EventType::ALL`] is the list, in upstream order.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
        #[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
        pub enum EventType {
            $(
                $(#[$meta])*
                #[serde(rename = $tag)]
                $variant,
            )*
        }

        impl EventType {
            /// Every event type the protocol defines, in upstream order.
            pub const ALL: &'static [EventType] = &[$(EventType::$variant),*];

            /// The wire string for this type.
            pub const fn as_str(&self) -> &'static str {
                match self {
                    $(Self::$variant => $tag,)*
                }
            }
        }

        impl FromStr for EventType {
            type Err = Error;

            fn from_str(s: &str) -> Result<Self> {
                match s {
                    $($tag => Ok(Self::$variant),)*
                    other => Err(Error::UnknownEventType(other.to_owned())),
                }
            }
        }

        impl Event {
            /// The discriminator for this event.
            pub const fn event_type(&self) -> EventType {
                match self {
                    $(Self::$variant(_) => EventType::$variant,)*
                }
            }

            /// The timestamp and raw-event fields, whatever the variant.
            pub const fn base(&self) -> &BaseEvent {
                match self {
                    $(Self::$variant(payload) => &payload.base,)*
                }
            }

            /// Mutable access to the timestamp and raw-event fields.
            pub const fn base_mut(&mut self) -> &mut BaseEvent {
                match self {
                    $(Self::$variant(payload) => &mut payload.base,)*
                }
            }
        }

        $(
            impl From<$payload> for Event {
                fn from(payload: $payload) -> Self {
                    Self::$variant(payload)
                }
            }
        )*
    };
}

define_events! {
    /// Opens a text message. See [`TextMessageStartEvent`].
    TextMessageStart(TextMessageStartEvent) => "TEXT_MESSAGE_START",
    /// Appends to a text message. See [`TextMessageContentEvent`].
    TextMessageContent(TextMessageContentEvent) => "TEXT_MESSAGE_CONTENT",
    /// Closes a text message. See [`TextMessageEndEvent`].
    TextMessageEnd(TextMessageEndEvent) => "TEXT_MESSAGE_END",
    /// A whole text update in one event. See [`TextMessageChunkEvent`].
    TextMessageChunk(TextMessageChunkEvent) => "TEXT_MESSAGE_CHUNK",
    /// Opens a tool call. See [`ToolCallStartEvent`].
    ToolCallStart(ToolCallStartEvent) => "TOOL_CALL_START",
    /// Appends tool-call arguments. See [`ToolCallArgsEvent`].
    ToolCallArgs(ToolCallArgsEvent) => "TOOL_CALL_ARGS",
    /// Closes a tool call. See [`ToolCallEndEvent`].
    ToolCallEnd(ToolCallEndEvent) => "TOOL_CALL_END",
    /// A whole tool call in one event. See [`ToolCallChunkEvent`].
    ToolCallChunk(ToolCallChunkEvent) => "TOOL_CALL_CHUNK",
    /// A tool call's result. See [`ToolCallResultEvent`].
    ToolCallResult(ToolCallResultEvent) => "TOOL_CALL_RESULT",
    /// Opens a thinking block. See [`ThinkingStartEvent`].
    #[cfg_attr(not(feature = "utoipa"), deprecated(note = "use Event::ReasoningStart"))]
    ThinkingStart(ThinkingStartEvent) => "THINKING_START",
    /// Closes a thinking block. See [`ThinkingEndEvent`].
    #[cfg_attr(not(feature = "utoipa"), deprecated(note = "use Event::ReasoningEnd"))]
    ThinkingEnd(ThinkingEndEvent) => "THINKING_END",
    /// Opens a thinking message. See [`ThinkingTextMessageStartEvent`].
    #[cfg_attr(not(feature = "utoipa"), deprecated(note = "use Event::ReasoningMessageStart"))]
    ThinkingTextMessageStart(ThinkingTextMessageStartEvent) => "THINKING_TEXT_MESSAGE_START",
    /// Appends thinking text. See [`ThinkingTextMessageContentEvent`].
    #[cfg_attr(not(feature = "utoipa"), deprecated(note = "use Event::ReasoningMessageContent"))]
    ThinkingTextMessageContent(ThinkingTextMessageContentEvent) => "THINKING_TEXT_MESSAGE_CONTENT",
    /// Closes a thinking message. See [`ThinkingTextMessageEndEvent`].
    #[cfg_attr(not(feature = "utoipa"), deprecated(note = "use Event::ReasoningMessageEnd"))]
    ThinkingTextMessageEnd(ThinkingTextMessageEndEvent) => "THINKING_TEXT_MESSAGE_END",
    /// Replaces the shared state. See [`StateSnapshotEvent`].
    StateSnapshot(StateSnapshotEvent) => "STATE_SNAPSHOT",
    /// Patches the shared state. See [`StateDeltaEvent`].
    StateDelta(StateDeltaEvent) => "STATE_DELTA",
    /// Replaces the message history. See [`MessagesSnapshotEvent`].
    MessagesSnapshot(MessagesSnapshotEvent) => "MESSAGES_SNAPSHOT",
    /// Publishes an activity. See [`ActivitySnapshotEvent`].
    ActivitySnapshot(ActivitySnapshotEvent) => "ACTIVITY_SNAPSHOT",
    /// Patches an activity. See [`ActivityDeltaEvent`].
    ActivityDelta(ActivityDeltaEvent) => "ACTIVITY_DELTA",
    /// Forwards a provider event. See [`RawEvent`].
    Raw(RawEvent) => "RAW",
    /// An application-defined event. See [`CustomEvent`].
    Custom(CustomEvent) => "CUSTOM",
    /// Starts a run. See [`RunStartedEvent`].
    RunStarted(RunStartedEvent) => "RUN_STARTED",
    /// Finishes or pauses a run. See [`RunFinishedEvent`].
    RunFinished(RunFinishedEvent) => "RUN_FINISHED",
    /// Fails a run. See [`RunErrorEvent`].
    RunError(RunErrorEvent) => "RUN_ERROR",
    /// Starts a step. See [`StepStartedEvent`].
    StepStarted(StepStartedEvent) => "STEP_STARTED",
    /// Finishes a step. See [`StepFinishedEvent`].
    StepFinished(StepFinishedEvent) => "STEP_FINISHED",
    /// Opens a reasoning block. See [`ReasoningStartEvent`].
    ReasoningStart(ReasoningStartEvent) => "REASONING_START",
    /// Opens a reasoning message. See [`ReasoningMessageStartEvent`].
    ReasoningMessageStart(ReasoningMessageStartEvent) => "REASONING_MESSAGE_START",
    /// Appends reasoning text. See [`ReasoningMessageContentEvent`].
    ReasoningMessageContent(ReasoningMessageContentEvent) => "REASONING_MESSAGE_CONTENT",
    /// Closes a reasoning message. See [`ReasoningMessageEndEvent`].
    ReasoningMessageEnd(ReasoningMessageEndEvent) => "REASONING_MESSAGE_END",
    /// A whole reasoning update in one event. See [`ReasoningMessageChunkEvent`].
    ReasoningMessageChunk(ReasoningMessageChunkEvent) => "REASONING_MESSAGE_CHUNK",
    /// Closes a reasoning block. See [`ReasoningEndEvent`].
    ReasoningEnd(ReasoningEndEvent) => "REASONING_END",
    /// Carries an encrypted reasoning blob. See [`ReasoningEncryptedValueEvent`].
    ReasoningEncryptedValue(ReasoningEncryptedValueEvent) => "REASONING_ENCRYPTED_VALUE",
    /// Announces a subagent invocation. See [`SubagentStartedEvent`].
    SubagentStarted(SubagentStartedEvent) => "SUBAGENT_STARTED",
    /// Closes a subagent invocation. See [`SubagentFinishedEvent`].
    SubagentFinished(SubagentFinishedEvent) => "SUBAGENT_FINISHED",
    /// Fails a subagent invocation. See [`SubagentErrorEvent`].
    SubagentError(SubagentErrorEvent) => "SUBAGENT_ERROR",
}

impl fmt::Display for EventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Event {
    /// Stamps the event with a millisecond Unix timestamp.
    #[must_use]
    pub fn with_timestamp(mut self, timestamp: i64) -> Self {
        self.base_mut().timestamp = Some(timestamp);
        self
    }

    /// Attaches the provider event this was translated from.
    #[must_use]
    pub fn with_raw_event(mut self, raw_event: impl Into<Value>) -> Self {
        self.base_mut().raw_event = Some(raw_event.into());
        self
    }

    /// Attaches metadata, replacing any the event already carried. See
    /// [`crate::metadata`].
    #[must_use]
    pub fn with_metadata(mut self, metadata: JsonObject) -> Self {
        self.base_mut().metadata = Some(metadata);
        self
    }

    /// The event's metadata, if it carries any.
    pub const fn metadata(&self) -> Option<&JsonObject> {
        self.base().metadata.as_ref()
    }

    /// Whether this event's type is deprecated in favour of a `REASONING_*`
    /// one.
    pub const fn is_deprecated(&self) -> bool {
        matches!(
            self.event_type(),
            EventType::ThinkingStart
                | EventType::ThinkingEnd
                | EventType::ThinkingTextMessageStart
                | EventType::ThinkingTextMessageContent
                | EventType::ThinkingTextMessageEnd
        )
    }

    // ---- subagent attribution ------------------------------------------

    /// The `subagentRunId` slot of the 24 event types that carry attribution.
    ///
    /// Hand-written and exhaustive: a new variant has to be placed on one
    /// side or the other here, which is the point.
    fn attribution(&self) -> Option<&Option<SubagentRunId>> {
        match self {
            Self::TextMessageStart(e) => Some(&e.subagent_run_id),
            Self::TextMessageContent(e) => Some(&e.subagent_run_id),
            Self::TextMessageEnd(e) => Some(&e.subagent_run_id),
            Self::TextMessageChunk(e) => Some(&e.subagent_run_id),
            Self::ToolCallStart(e) => Some(&e.subagent_run_id),
            Self::ToolCallArgs(e) => Some(&e.subagent_run_id),
            Self::ToolCallEnd(e) => Some(&e.subagent_run_id),
            Self::ToolCallChunk(e) => Some(&e.subagent_run_id),
            Self::ToolCallResult(e) => Some(&e.subagent_run_id),
            Self::StateSnapshot(e) => Some(&e.subagent_run_id),
            Self::StateDelta(e) => Some(&e.subagent_run_id),
            Self::ActivitySnapshot(e) => Some(&e.subagent_run_id),
            Self::ActivityDelta(e) => Some(&e.subagent_run_id),
            Self::Raw(e) => Some(&e.subagent_run_id),
            Self::Custom(e) => Some(&e.subagent_run_id),
            Self::StepStarted(e) => Some(&e.subagent_run_id),
            Self::StepFinished(e) => Some(&e.subagent_run_id),
            Self::ReasoningStart(e) => Some(&e.subagent_run_id),
            Self::ReasoningMessageStart(e) => Some(&e.subagent_run_id),
            Self::ReasoningMessageContent(e) => Some(&e.subagent_run_id),
            Self::ReasoningMessageEnd(e) => Some(&e.subagent_run_id),
            Self::ReasoningMessageChunk(e) => Some(&e.subagent_run_id),
            Self::ReasoningEnd(e) => Some(&e.subagent_run_id),
            Self::ReasoningEncryptedValue(e) => Some(&e.subagent_run_id),
            Self::RunStarted(_)
            | Self::RunFinished(_)
            | Self::RunError(_)
            | Self::MessagesSnapshot(_)
            | Self::ThinkingStart(_)
            | Self::ThinkingEnd(_)
            | Self::ThinkingTextMessageStart(_)
            | Self::ThinkingTextMessageContent(_)
            | Self::ThinkingTextMessageEnd(_)
            | Self::SubagentStarted(_)
            | Self::SubagentFinished(_)
            | Self::SubagentError(_) => None,
        }
    }

    fn attribution_mut(&mut self) -> Option<&mut Option<SubagentRunId>> {
        match self {
            Self::TextMessageStart(e) => Some(&mut e.subagent_run_id),
            Self::TextMessageContent(e) => Some(&mut e.subagent_run_id),
            Self::TextMessageEnd(e) => Some(&mut e.subagent_run_id),
            Self::TextMessageChunk(e) => Some(&mut e.subagent_run_id),
            Self::ToolCallStart(e) => Some(&mut e.subagent_run_id),
            Self::ToolCallArgs(e) => Some(&mut e.subagent_run_id),
            Self::ToolCallEnd(e) => Some(&mut e.subagent_run_id),
            Self::ToolCallChunk(e) => Some(&mut e.subagent_run_id),
            Self::ToolCallResult(e) => Some(&mut e.subagent_run_id),
            Self::StateSnapshot(e) => Some(&mut e.subagent_run_id),
            Self::StateDelta(e) => Some(&mut e.subagent_run_id),
            Self::ActivitySnapshot(e) => Some(&mut e.subagent_run_id),
            Self::ActivityDelta(e) => Some(&mut e.subagent_run_id),
            Self::Raw(e) => Some(&mut e.subagent_run_id),
            Self::Custom(e) => Some(&mut e.subagent_run_id),
            Self::StepStarted(e) => Some(&mut e.subagent_run_id),
            Self::StepFinished(e) => Some(&mut e.subagent_run_id),
            Self::ReasoningStart(e) => Some(&mut e.subagent_run_id),
            Self::ReasoningMessageStart(e) => Some(&mut e.subagent_run_id),
            Self::ReasoningMessageContent(e) => Some(&mut e.subagent_run_id),
            Self::ReasoningMessageEnd(e) => Some(&mut e.subagent_run_id),
            Self::ReasoningMessageChunk(e) => Some(&mut e.subagent_run_id),
            Self::ReasoningEnd(e) => Some(&mut e.subagent_run_id),
            Self::ReasoningEncryptedValue(e) => Some(&mut e.subagent_run_id),
            Self::RunStarted(_)
            | Self::RunFinished(_)
            | Self::RunError(_)
            | Self::MessagesSnapshot(_)
            | Self::ThinkingStart(_)
            | Self::ThinkingEnd(_)
            | Self::ThinkingTextMessageStart(_)
            | Self::ThinkingTextMessageContent(_)
            | Self::ThinkingTextMessageEnd(_)
            | Self::SubagentStarted(_)
            | Self::SubagentFinished(_)
            | Self::SubagentError(_) => None,
        }
    }

    /// The subagent this event belongs to.
    ///
    /// `None` means the parent agent — or an event type that carries no
    /// attribution at all; [`EventType::is_attributable`] tells the two
    /// apart. For the three `SUBAGENT_*` lifecycle events this is the
    /// subagent they announce, which is required rather than optional.
    pub fn subagent_run_id(&self) -> Option<&SubagentRunId> {
        match self {
            Self::SubagentStarted(e) => Some(&e.subagent_run_id),
            Self::SubagentFinished(e) => Some(&e.subagent_run_id),
            Self::SubagentError(e) => Some(&e.subagent_run_id),
            _ => self.attribution().and_then(Option::as_ref),
        }
    }

    /// Attributes the event to `id`.
    ///
    /// Returns `false`, leaving the event untouched, for the nine event types
    /// the protocol defines without the field: `RUN_*`, `MESSAGES_SNAPSHOT`
    /// and the deprecated `THINKING_*` family. On a `SUBAGENT_*` event it sets
    /// the subject.
    pub fn set_subagent_run_id(&mut self, id: impl Into<SubagentRunId>) -> bool {
        let id = id.into();
        match self {
            Self::SubagentStarted(e) => e.subagent_run_id = id,
            Self::SubagentFinished(e) => e.subagent_run_id = id,
            Self::SubagentError(e) => e.subagent_run_id = id,
            _ => match self.attribution_mut() {
                Some(slot) => *slot = Some(id),
                None => return false,
            },
        }
        true
    }

    /// Removes attribution from an attributable event and returns it.
    ///
    /// The `SUBAGENT_*` events carry their id as a required subject, so this
    /// leaves them alone and returns `None`, as it does for the event types
    /// that never carry the field.
    pub fn clear_subagent_run_id(&mut self) -> Option<SubagentRunId> {
        self.attribution_mut().and_then(Option::take)
    }

    /// Builder form of [`set_subagent_run_id`](Self::set_subagent_run_id); a
    /// no-op on the event types that cannot carry attribution.
    #[must_use]
    pub fn with_subagent_run_id(mut self, id: impl Into<SubagentRunId>) -> Self {
        self.set_subagent_run_id(id);
        self
    }
}

impl EventType {
    /// Whether this event type carries the optional `subagentRunId`
    /// attribution — 24 of the 36 do.
    ///
    /// The three `SUBAGENT_*` lifecycle events return `false`: they carry the
    /// field as their required subject, not as a tag. The run lifecycle,
    /// `MESSAGES_SNAPSHOT` (whose messages carry their own) and the deprecated
    /// `THINKING_*` family have no such field.
    pub const fn is_attributable(self) -> bool {
        !matches!(
            self,
            Self::RunStarted
                | Self::RunFinished
                | Self::RunError
                | Self::MessagesSnapshot
                | Self::ThinkingStart
                | Self::ThinkingEnd
                | Self::ThinkingTextMessageStart
                | Self::ThinkingTextMessageContent
                | Self::ThinkingTextMessageEnd
                | Self::SubagentStarted
                | Self::SubagentFinished
                | Self::SubagentError
        )
    }
}
