//! The one extension point: rewriting the event stream on its way out.
//!
//! Everything that wants to observe, drop, rewrite or add events implements
//! [`StreamTransformer`]. There is deliberately no second mechanism — an early
//! draft of this crate also carried a builder of `map_content` / `map_result` /
//! `map_interrupt` closures ported from the .NET SDK, which meant two ways to
//! do the same thing and a pile of `Box<dyn Fn>`. Those hooks are built-in
//! transformers now: see [`ToolResultToState`]. So is the compatibility knob
//! for consumers that predate subagents: [`SubagentVisibility`].
//!
//! Transformers run in the order they were added, each seeing what the previous
//! one produced, before the ordering verifier sees anything. That order is what
//! makes [`FilterToolCalls`] safe: the verifier never sees the half of a tool
//! call that was dropped.
//!
//! ```
//! # use ag_ui::server::{FilterToolCalls, TransformerChain, ToolResultToState};
//! let chain = TransformerChain::new()
//!     .with(FilterToolCalls::deny(["internal_debug"]))
//!     .with(ToolResultToState::snapshot("load_document").replacing());
//! assert_eq!(chain.len(), 2);
//! ```

use std::collections::{HashMap, HashSet};

use crate::{Event, MessageId, PatchOperation, SubagentRunId, ToolCallId};
use serde_json::Value;

/// Rewrites events on their way from an agent to the transport.
///
/// # Why `&mut self`
///
/// Any useful transformer is a small state machine: dropping a tool call means
/// remembering which id was dropped so its `TOOL_CALL_ARGS` go too. Taking
/// `&mut self` says that directly instead of pushing every implementation into
/// `RefCell`. The chain is owned by the run, so there is no sharing to lose.
///
/// # Contract
///
/// Returning an empty `Vec` drops the event. Returning several events splices
/// them in, in order. A transformer that drops the start of something must drop
/// its continuation and terminator too, or the ordering verifier will reject
/// what it produces.
pub trait StreamTransformer: Send {
    /// Rewrites one event into zero or more events.
    fn transform(&mut self, event: Event) -> Vec<Event>;
}

/// Transformers applied in sequence.
///
/// An empty chain is free: the run skips it entirely rather than allocating a
/// `Vec` per event.
#[derive(Default)]
pub struct TransformerChain {
    transformers: Vec<Box<dyn StreamTransformer>>,
}

impl std::fmt::Debug for TransformerChain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransformerChain")
            .field("len", &self.transformers.len())
            .finish()
    }
}

impl TransformerChain {
    /// An empty chain.
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends a transformer, returning the chain for further building.
    #[must_use]
    pub fn with(mut self, transformer: impl StreamTransformer + 'static) -> Self {
        self.push(transformer);
        self
    }

    /// Appends a transformer.
    pub fn push(&mut self, transformer: impl StreamTransformer + 'static) {
        self.transformers.push(Box::new(transformer));
    }

    /// How many transformers are in the chain.
    pub fn len(&self) -> usize {
        self.transformers.len()
    }

    /// Whether the chain would pass every event through untouched.
    pub fn is_empty(&self) -> bool {
        self.transformers.is_empty()
    }

    /// Runs `event` through every transformer in order.
    pub fn transform(&mut self, event: Event) -> Vec<Event> {
        let mut current = vec![event];
        for transformer in &mut self.transformers {
            let mut next = Vec::with_capacity(current.len());
            for event in current.drain(..) {
                next.extend(transformer.transform(event));
            }
            current = next;
            if current.is_empty() {
                break;
            }
        }
        current
    }
}

impl StreamTransformer for TransformerChain {
    fn transform(&mut self, event: Event) -> Vec<Event> {
        Self::transform(self, event)
    }
}

/// Which side of the list passes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum FilterMode {
    Allow,
    Deny,
}

/// Drops whole tool calls by tool name.
///
/// Both halves of a call are removed — `TOOL_CALL_START`, its `TOOL_CALL_ARGS`,
/// the `TOOL_CALL_END`, the `TOOL_CALL_RESULT` and any encrypted reasoning blob
/// attached to it — so what reaches the client is a stream that never mentions
/// the tool.
///
/// ```
/// # use ag_ui::Event;
/// # use ag_ui::server::{FilterToolCalls, StreamTransformer};
/// let mut filter = FilterToolCalls::deny(["secret_tool"]);
/// assert!(filter.transform(Event::tool_call_start("c1", "secret_tool")).is_empty());
/// assert!(filter.transform(Event::tool_call_args("c1", "{}")).is_empty());
/// assert_eq!(filter.transform(Event::tool_call_start("c2", "public")).len(), 1);
/// ```
#[derive(Clone, Debug)]
pub struct FilterToolCalls {
    mode: FilterMode,
    names: HashSet<String>,
    dropped: HashSet<ToolCallId>,
}

impl FilterToolCalls {
    /// Passes only calls to the named tools.
    pub fn allow<I, T>(names: I) -> Self
    where
        I: IntoIterator<Item = T>,
        T: Into<String>,
    {
        Self::new(FilterMode::Allow, names)
    }

    /// Passes everything except calls to the named tools.
    pub fn deny<I, T>(names: I) -> Self
    where
        I: IntoIterator<Item = T>,
        T: Into<String>,
    {
        Self::new(FilterMode::Deny, names)
    }

    fn new<I, T>(mode: FilterMode, names: I) -> Self
    where
        I: IntoIterator<Item = T>,
        T: Into<String>,
    {
        Self {
            mode,
            names: names.into_iter().map(Into::into).collect(),
            dropped: HashSet::new(),
        }
    }

    fn passes(&self, name: &str) -> bool {
        match self.mode {
            FilterMode::Allow => self.names.contains(name),
            FilterMode::Deny => !self.names.contains(name),
        }
    }

    /// Records the verdict for a call and reports whether it should be dropped.
    fn judge(&mut self, id: &ToolCallId, name: &str) -> bool {
        if self.passes(name) {
            self.dropped.remove(id);
            false
        } else {
            self.dropped.insert(id.clone());
            true
        }
    }
}

impl StreamTransformer for FilterToolCalls {
    fn transform(&mut self, event: Event) -> Vec<Event> {
        let drop = match &event {
            Event::ToolCallStart(payload) => {
                self.judge(&payload.tool_call_id, &payload.tool_call_name)
            }
            Event::ToolCallChunk(payload) => match (&payload.tool_call_id, &payload.tool_call_name)
            {
                (Some(id), Some(name)) => self.judge(id, name),
                (Some(id), None) => self.dropped.contains(id),
                _ => false,
            },
            Event::ToolCallArgs(payload) => self.dropped.contains(&payload.tool_call_id),
            Event::ToolCallEnd(payload) => self.dropped.contains(&payload.tool_call_id),
            Event::ToolCallResult(payload) => self.dropped.contains(&payload.tool_call_id),
            Event::ReasoningEncryptedValue(payload) => {
                payload.subtype == crate::ReasoningEncryptedValueSubtype::ToolCall
                    && self.dropped.contains(&ToolCallId::new(&payload.entity_id))
            }
            _ => false,
        };

        if drop { Vec::new() } else { vec![event] }
    }
}

/// How a promoted tool result reaches the client's state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum StateForm {
    /// The result is the new state.
    Snapshot,
    /// The result is an RFC 6902 patch against the current state.
    Delta,
}

/// Promotes a named tool's result into a state event.
///
/// A tool whose job is to produce state — `load_document`, `set_filters` —
/// otherwise forces the agent to emit the result and then publish the state by
/// hand. This transformer does it: when `tool_name` returns, its JSON content
/// becomes a `STATE_SNAPSHOT` or a `STATE_DELTA`.
///
/// The result event is kept by default so the client still sees the tool
/// completed; [`replacing`](Self::replacing) drops it instead. Content that is
/// not JSON of the expected shape is left alone — a malformed result must not
/// take down the run.
///
/// ```
/// # use ag_ui::Event;
/// # use ag_ui::server::{StreamTransformer, ToolResultToState};
/// let mut promote = ToolResultToState::snapshot("load_document").replacing();
/// promote.transform(Event::tool_call_start("c1", "load_document"));
/// let out = promote.transform(Event::tool_call_result("m1", "c1", r#"{"title":"Notes"}"#));
/// assert_eq!(out, vec![Event::state_snapshot(serde_json::json!({"title": "Notes"}))]);
/// ```
#[derive(Clone, Debug)]
pub struct ToolResultToState {
    tool_name: String,
    form: StateForm,
    keep_result: bool,
    names: HashMap<ToolCallId, String>,
}

impl ToolResultToState {
    /// Turns `tool_name`'s result into a `STATE_SNAPSHOT`.
    pub fn snapshot(tool_name: impl Into<String>) -> Self {
        Self::new(tool_name, StateForm::Snapshot)
    }

    /// Turns `tool_name`'s result into a `STATE_DELTA`. The result content must
    /// be a JSON array of RFC 6902 operations.
    pub fn delta(tool_name: impl Into<String>) -> Self {
        Self::new(tool_name, StateForm::Delta)
    }

    fn new(tool_name: impl Into<String>, form: StateForm) -> Self {
        Self {
            tool_name: tool_name.into(),
            form,
            keep_result: true,
            names: HashMap::new(),
        }
    }

    /// Drops the `TOOL_CALL_RESULT` instead of emitting it alongside the state
    /// event.
    #[must_use]
    pub fn replacing(mut self) -> Self {
        self.keep_result = false;
        self
    }

    fn state_event(&self, content: &str) -> Option<Event> {
        match self.form {
            StateForm::Snapshot => serde_json::from_str::<Value>(content)
                .ok()
                .map(Event::state_snapshot),
            StateForm::Delta => serde_json::from_str::<Vec<PatchOperation>>(content)
                .ok()
                .map(Event::state_delta),
        }
    }
}

impl StreamTransformer for ToolResultToState {
    fn transform(&mut self, event: Event) -> Vec<Event> {
        match &event {
            Event::ToolCallStart(payload) => {
                if payload.tool_call_name == self.tool_name {
                    self.names
                        .insert(payload.tool_call_id.clone(), payload.tool_call_name.clone());
                }
            }
            Event::ToolCallChunk(payload) => {
                match (&payload.tool_call_id, &payload.tool_call_name) {
                    (Some(id), Some(name)) if name == &self.tool_name => {
                        self.names.insert(id.clone(), name.clone());
                    }
                    _ => {}
                }
            }
            Event::ToolCallResult(payload) => {
                let promoted = self
                    .names
                    .remove(&payload.tool_call_id)
                    .and_then(|_| self.state_event(&payload.content))
                    .map(|mut state| {
                        // Provenance travels with the state: a subagent's
                        // result promoted is the subagent's publish.
                        if let Some(id) = &payload.subagent_run_id {
                            state.set_subagent_run_id(id.clone());
                        }
                        state
                    });
                if let Some(state) = promoted {
                    return if self.keep_result {
                        vec![event, state]
                    } else {
                        vec![state]
                    };
                }
            }
            _ => {}
        }
        vec![event]
    }
}

/// What a consumer sees of an agent's subagents.
///
/// [`Attributed`](Self::Attributed) — the default, and no transformer at all —
/// sends the stream as the agent emitted it. The other two exist because a
/// client older than `@ag-ui/client` 0.0.59 rejects the `SUBAGENT_*` event
/// *types* while decoding: an unknown field is tolerated, an unknown event
/// type is not, and there is nothing a client can do about it after the
/// fact. A producer with such consumers must not send them, and this is how
/// it does not.
///
/// Upstream's integrations default to inline and make the full surface
/// opt-in. This crate defaults the other way, because a transformer that
/// rewrites the stream is opt-in here like every other: an agent that wrote
/// `ctx.subagent(..)` meant it, and silently flattening what it said is the
/// kind of surprise the design notes argue against. Flip it per endpoint when
/// your consumers are older:
///
/// ```
/// # use ag_ui::RunOutcome;
/// # use ag_ui::server::{Agent, Result, RunContext, Runner, SubagentVisibility};
/// # struct MyAgent;
/// # impl Agent for MyAgent {
/// #     type State = ();
/// #     async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> { Ok(RunOutcome::Success) }
/// # }
/// let runner = Runner::new(MyAgent).transformer(SubagentVisibility::inline());
/// # let _ = runner;
/// ```
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum SubagentVisibility {
    /// The full surface: the lifecycle events, and `subagentRunId` on
    /// everything a subagent produced.
    #[default]
    Attributed,
    /// The pre-subagent shape: no lifecycle events and no `subagentRunId`
    /// anywhere — not on events, not on the messages inside
    /// `MESSAGES_SNAPSHOT` or the `RUN_STARTED` input echo, not on the
    /// interrupts a paused run reports. A subagent's own text arrives as the
    /// parent's work. A `*_CHUNK` event that named no id is given the one its
    /// attribution resolved to, since without the attribution the consumer
    /// would resolve it differently.
    ///
    /// A subagent's steps are dropped rather than flattened. A step brackets
    /// its own agent's graph, and as the parent's it would either collide
    /// with an open step of the same name — the common shape: a parent
    /// `tools` step wrapping the delegation and the child's own `tools`
    /// inside it — or misdescribe the parent's graph. The lifecycle events
    /// were the child's structure; so are its steps.
    Inline,
    /// Only the parent's own events. Everything a subagent produced is
    /// dropped — including the result of a call it requested, even when the
    /// parent executed it, since a result for a call the consumer never saw
    /// is a protocol error. The converse holds too: a result answering the
    /// *parent's* call is kept, untagged, whoever executed it — the consumer
    /// saw the call, and a call left unanswered in the history is what the
    /// next request would carry back.
    ///
    /// The one thing kept is the run's shared state. A `STATE_SNAPSHOT` or
    /// `STATE_DELTA` a subagent published describes the *thread's* state,
    /// not the subagent's work: a client that never saw it would mirror a
    /// stale state and send that back on its next request. It goes out with
    /// the tag cleared, as the parent's.
    Hidden,
}

impl SubagentVisibility {
    /// The transformer for this mode. Pointless but harmless for
    /// [`Attributed`](Self::Attributed), which passes everything through.
    pub fn filter(self) -> SubagentFilter {
        SubagentFilter::new(self)
    }

    /// The transformer for [`Inline`](Self::Inline).
    pub fn inline() -> SubagentFilter {
        Self::Inline.filter()
    }

    /// The transformer for [`Hidden`](Self::Hidden).
    pub fn hidden() -> SubagentFilter {
        Self::Hidden.filter()
    }
}

/// The transformer behind [`SubagentVisibility`].
///
/// Both modes keep the consuming normalizer's model of the stream — one open
/// chunk-continuable stream per owner — because a `*_CHUNK` event that names
/// no id is resolved *through its attribution* on the consuming side, and
/// stripping the attribution would send it to the wrong stream. Such a chunk
/// is given the id it resolves to (and, for a tool call, the name the
/// consumer needs to reopen it) before its tag goes.
///
/// [`Hidden`](SubagentVisibility::Hidden) additionally remembers what each
/// subagent owns — messages, tool calls, activities — for the rest of the
/// run, not only while they are open, so an untagged continuation, re-open,
/// patch or result for a subagent's entity is dropped with the rest of it
/// rather than leaking into the parent's stream. That is the owner-aware
/// verifier's reading too: the first writer owns the id, and an absent tag
/// agrees with any owner. An entity the consumer has seen opened keeps that
/// visibility until it closes, whatever a snapshot says about its owner
/// meanwhile — a consumer must never be left with a message it saw opened
/// and never sees closed.
#[derive(Debug)]
pub struct SubagentFilter {
    mode: SubagentVisibility,
    /// The open streams, per owner.
    streams: Streams,
    /// Text message ids a subagent owns, and which.
    hidden_text: HashMap<MessageId, SubagentRunId>,
    /// Reasoning ids — the block and the message inside it — a subagent
    /// owns. A bucket of its own, as the verifiers keep it, so a producer
    /// that reuses an id across the two kinds is not misread.
    hidden_reasoning: HashMap<MessageId, SubagentRunId>,
    /// Tool call ids a subagent owns — or that sit in a message it owns.
    hidden_tool_calls: HashMap<ToolCallId, SubagentRunId>,
    /// Every activity seen, and whether a subagent owns it.
    activities: HashMap<MessageId, bool>,
    /// What is open, and whether the consumer saw it open.
    open_visibility: HashMap<(Family, String), bool>,
    /// Whether the consumer saw each tool call start, for the result that
    /// may arrive long after the call closed.
    call_visibility: HashMap<ToolCallId, bool>,
}

/// The families a `*_CHUNK` event may continue.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Family {
    Text,
    Reasoning,
    Tool,
}

/// One open stream, as the consuming normalizer models it.
#[derive(Clone, Debug)]
struct Stream {
    family: Family,
    id: String,
    /// What a chunk reopening a tool call on the consuming side must carry.
    tool_name: Option<String>,
    parent_message_id: Option<MessageId>,
}

/// The open streams: one per owner, replaced by the next that owner opens,
/// closed by a terminator or — for whoever executed it — by a tool result.
#[derive(Debug, Default)]
struct Streams {
    parent: Option<Stream>,
    subagents: HashMap<SubagentRunId, Stream>,
}

/// What a chunk naming no id turned out to be.
enum Bare {
    /// Not such a chunk.
    No,
    /// Resolved to a stream, and given its id.
    Resolved {
        owner: Option<SubagentRunId>,
        family: Family,
        id: String,
    },
    /// Nothing to resolve it against; the consumer will say so.
    Unresolved,
}

impl Streams {
    /// `owner` now has `stream` open, and nothing else — unless it is the
    /// same stream, in which case what is known about it is kept.
    fn open(&mut self, owner: &Option<SubagentRunId>, stream: Stream) {
        let current = match owner {
            None => &mut self.parent,
            Some(owner) => match self.subagents.get_mut(owner) {
                Some(current) => {
                    Self::replace(current, stream);
                    return;
                }
                None => {
                    self.subagents.insert(owner.clone(), stream);
                    return;
                }
            },
        };
        match current {
            Some(current) => Self::replace(current, stream),
            None => *current = Some(stream),
        }
    }

    fn replace(current: &mut Stream, stream: Stream) {
        if current.family == stream.family && current.id == stream.id {
            if current.tool_name.is_none() {
                current.tool_name = stream.tool_name;
            }
            if current.parent_message_id.is_none() {
                current.parent_message_id = stream.parent_message_id;
            }
        } else {
            *current = stream;
        }
    }

    fn close_id(&mut self, family: Family, id: &str) {
        if self
            .parent
            .as_ref()
            .is_some_and(|open| open.family == family && open.id == id)
        {
            self.parent = None;
        }
        self.subagents
            .retain(|_, open| !(open.family == family && open.id == id));
    }

    fn close_owner(&mut self, owner: &Option<SubagentRunId>) {
        match owner {
            None => self.parent = None,
            Some(owner) => {
                self.subagents.remove(owner);
            }
        }
    }

    fn clear(&mut self) {
        self.parent = None;
        self.subagents.clear();
    }

    /// The subagent under which `id` is open, if it is open under one.
    fn owner_of_open(&self, family: Family, id: &str) -> Option<SubagentRunId> {
        self.subagents
            .iter()
            .find(|(_, open)| open.family == family && open.id == id)
            .map(|(owner, _)| owner.clone())
    }

    /// The stream a chunk naming no id continues — the normalizer's rule:
    /// the tagged owner's open stream; untagged, the parent's, else the only
    /// open one.
    fn resolve(
        &self,
        family: Family,
        tag: &Option<SubagentRunId>,
    ) -> Option<(Option<SubagentRunId>, Stream)> {
        let of_family = |open: &&Stream| open.family == family;
        if let Some(owner) = tag {
            return self
                .subagents
                .get(owner)
                .filter(of_family)
                .map(|open| (Some(owner.clone()), open.clone()));
        }
        if let Some(open) = self.parent.as_ref().filter(of_family) {
            return Some((None, open.clone()));
        }
        let mut candidates = self
            .subagents
            .iter()
            .filter(|(_, open)| open.family == family);
        match (candidates.next(), candidates.next()) {
            (Some((owner, open)), None) => Some((Some(owner.clone()), open.clone())),
            _ => None,
        }
    }

    /// Folds an event with an id into the model. `owner` is whose the event
    /// is; `tag` is what it carries, which is what a result closes by.
    fn observe(
        &mut self,
        event: &Event,
        owner: &Option<SubagentRunId>,
        tag: &Option<SubagentRunId>,
    ) {
        let text = |id: &MessageId| Stream {
            family: Family::Text,
            id: id.as_str().to_owned(),
            tool_name: None,
            parent_message_id: None,
        };
        let reasoning = |id: &MessageId| Stream {
            family: Family::Reasoning,
            id: id.as_str().to_owned(),
            tool_name: None,
            parent_message_id: None,
        };
        let tool = |id: &ToolCallId, name: Option<&String>, parent: Option<&MessageId>| Stream {
            family: Family::Tool,
            id: id.as_str().to_owned(),
            tool_name: name.cloned(),
            parent_message_id: parent.cloned(),
        };
        match event {
            Event::TextMessageStart(e) => self.open(owner, text(&e.message_id)),
            Event::TextMessageContent(e) => self.open(owner, text(&e.message_id)),
            Event::TextMessageEnd(e) => self.close_id(Family::Text, e.message_id.as_str()),
            Event::TextMessageChunk(e) => {
                if let Some(id) = &e.message_id {
                    self.open(owner, text(id));
                }
            }
            Event::ReasoningMessageStart(e) => self.open(owner, reasoning(&e.message_id)),
            Event::ReasoningMessageContent(e) => self.open(owner, reasoning(&e.message_id)),
            Event::ReasoningMessageEnd(e) => {
                self.close_id(Family::Reasoning, e.message_id.as_str());
            }
            Event::ReasoningEnd(e) => self.close_id(Family::Reasoning, e.message_id.as_str()),
            Event::ReasoningMessageChunk(e) => {
                if let Some(id) = &e.message_id {
                    self.open(owner, reasoning(id));
                }
            }
            Event::ToolCallStart(e) => self.open(
                owner,
                tool(
                    &e.tool_call_id,
                    Some(&e.tool_call_name),
                    e.parent_message_id.as_ref(),
                ),
            ),
            Event::ToolCallArgs(e) => self.open(owner, tool(&e.tool_call_id, None, None)),
            Event::ToolCallEnd(e) => self.close_id(Family::Tool, e.tool_call_id.as_str()),
            Event::ToolCallChunk(e) => {
                if let Some(id) = &e.tool_call_id {
                    self.open(
                        owner,
                        tool(id, e.tool_call_name.as_ref(), e.parent_message_id.as_ref()),
                    );
                }
            }
            // A result answers a call, so the call is over — and the party
            // answering has moved on from whatever else it had open.
            Event::ToolCallResult(e) => {
                self.close_id(Family::Tool, e.tool_call_id.as_str());
                self.close_owner(tag);
            }
            Event::RunFinished(_) | Event::RunError(_) => self.clear(),
            _ => {}
        }
    }
}

impl SubagentFilter {
    /// A filter for `mode`.
    pub fn new(mode: SubagentVisibility) -> Self {
        Self {
            mode,
            streams: Streams::default(),
            hidden_text: HashMap::new(),
            hidden_reasoning: HashMap::new(),
            hidden_tool_calls: HashMap::new(),
            activities: HashMap::new(),
            open_visibility: HashMap::new(),
            call_visibility: HashMap::new(),
        }
    }

    /// The mode this filter applies.
    pub fn mode(&self) -> SubagentVisibility {
        self.mode
    }

    /// The stream a stream-bearing event belongs to, if it names one.
    fn entity(event: &Event) -> Option<(Family, &str)> {
        Some(match event {
            Event::TextMessageStart(e) => (Family::Text, e.message_id.as_str()),
            Event::TextMessageContent(e) => (Family::Text, e.message_id.as_str()),
            Event::TextMessageEnd(e) => (Family::Text, e.message_id.as_str()),
            Event::TextMessageChunk(e) => (Family::Text, e.message_id.as_ref()?.as_str()),
            Event::ReasoningStart(e) => (Family::Reasoning, e.message_id.as_str()),
            Event::ReasoningMessageStart(e) => (Family::Reasoning, e.message_id.as_str()),
            Event::ReasoningMessageContent(e) => (Family::Reasoning, e.message_id.as_str()),
            Event::ReasoningMessageEnd(e) => (Family::Reasoning, e.message_id.as_str()),
            Event::ReasoningEnd(e) => (Family::Reasoning, e.message_id.as_str()),
            Event::ReasoningMessageChunk(e) => (Family::Reasoning, e.message_id.as_ref()?.as_str()),
            Event::ToolCallStart(e) => (Family::Tool, e.tool_call_id.as_str()),
            Event::ToolCallArgs(e) => (Family::Tool, e.tool_call_id.as_str()),
            Event::ToolCallEnd(e) => (Family::Tool, e.tool_call_id.as_str()),
            Event::ToolCallResult(e) => (Family::Tool, e.tool_call_id.as_str()),
            Event::ToolCallChunk(e) => (Family::Tool, e.tool_call_id.as_ref()?.as_str()),
            _ => return None,
        })
    }

    /// The message a tool call sits in, when the event says.
    fn carrier(event: &Event) -> Option<&MessageId> {
        match event {
            Event::ToolCallStart(e) => e.parent_message_id.as_ref(),
            Event::ToolCallChunk(e) => e.parent_message_id.as_ref(),
            _ => None,
        }
    }

    /// Whose an event is: its tag; else the recorded owner of its entity —
    /// for a tool call, the owner of the message that carries it; else
    /// whoever has that entity open; else the parent.
    fn owner_for(&self, event: &Event, tag: &Option<SubagentRunId>) -> Option<SubagentRunId> {
        if tag.is_some() {
            return tag.clone();
        }
        let (family, id) = Self::entity(event)?;
        let recorded = match family {
            Family::Text => self.hidden_text.get(&MessageId::new(id)).cloned(),
            Family::Reasoning => self.hidden_reasoning.get(&MessageId::new(id)).cloned(),
            Family::Tool => Self::carrier(event)
                .and_then(|parent| self.hidden_text.get(parent).cloned())
                .or_else(|| self.hidden_tool_calls.get(&ToolCallId::new(id)).cloned()),
        };
        recorded.or_else(|| self.streams.owner_of_open(family, id))
    }

    /// Gives a chunk naming no id the id its attribution resolves to on the
    /// consuming side, so that stripping the attribution afterwards cannot
    /// send it to another stream.
    fn fill_bare(&self, event: &mut Event, tag: &Option<SubagentRunId>) -> Bare {
        let family = match event {
            Event::TextMessageChunk(e) if e.message_id.is_none() => Family::Text,
            Event::ReasoningMessageChunk(e) if e.message_id.is_none() => Family::Reasoning,
            Event::ToolCallChunk(e) if e.tool_call_id.is_none() => Family::Tool,
            _ => return Bare::No,
        };
        let Some((owner, stream)) = self.streams.resolve(family, tag) else {
            return Bare::Unresolved;
        };
        let id = stream.id.clone();
        match event {
            Event::TextMessageChunk(e) => e.message_id = Some(MessageId::new(&id)),
            Event::ReasoningMessageChunk(e) => e.message_id = Some(MessageId::new(&id)),
            Event::ToolCallChunk(e) => {
                e.tool_call_id = Some(ToolCallId::new(&id));
                if e.tool_call_name.is_none() {
                    e.tool_call_name = stream.tool_name;
                }
                if e.parent_message_id.is_none() {
                    e.parent_message_id = stream.parent_message_id;
                }
            }
            _ => unreachable!("matched above"),
        }
        Bare::Resolved { owner, family, id }
    }

    /// Strips the subagent surface from an event, or drops it entirely when
    /// it *is* the subagent surface — the lifecycle, and a subagent's steps.
    fn inline(&mut self, mut event: Event) -> Vec<Event> {
        let tag = event.subagent_run_id().cloned();
        if let Bare::No = self.fill_bare(&mut event, &tag) {
            let owner = self.owner_for(&event, &tag);
            self.streams.observe(&event, &owner, &tag);
        }
        let subagents_step =
            matches!(event, Event::StepStarted(_) | Event::StepFinished(_)) && tag.is_some();
        if subagents_step {
            return Vec::new();
        }
        match &mut event {
            Event::SubagentStarted(_) | Event::SubagentFinished(_) | Event::SubagentError(_) => {
                return Vec::new();
            }
            Event::MessagesSnapshot(snapshot) => {
                for message in &mut snapshot.messages {
                    message.set_subagent_run_id(None);
                }
            }
            Event::RunStarted(started) => {
                if let Some(input) = &mut started.input {
                    for message in &mut input.messages {
                        message.set_subagent_run_id(None);
                    }
                }
            }
            Event::RunFinished(finished) => Self::strip_interrupt_tags(finished),
            _ => {
                event.clear_subagent_run_id();
            }
        }
        vec![event]
    }

    /// The interrupts a paused run reports name the subagent that raised
    /// them, and a consumer that never saw that subagent has no group to
    /// file them under. The question still stands, so the interrupt stays;
    /// only the tag goes.
    fn strip_interrupt_tags(finished: &mut crate::RunFinishedEvent) {
        if let Some(crate::RunOutcome::Interrupt { interrupts }) = &mut finished.outcome {
            for interrupt in interrupts {
                interrupt.subagent_run_id = None;
            }
        }
    }

    /// Keeps the parent's events and drops a subagent's, remembering what
    /// each subagent owns so that an untagged event is judged by its opener.
    fn hidden(&mut self, mut event: Event) -> Vec<Event> {
        let tag = event.subagent_run_id().cloned();
        let owned = tag.is_some();
        let keep = match self.fill_bare(&mut event, &tag) {
            // The chunk continues a stream: it goes where the stream went.
            Bare::Resolved { owner, family, id } => self
                .open_visibility
                .get(&(family, id))
                .copied()
                .unwrap_or(owner.is_none()),
            Bare::Unresolved => !owned,
            Bare::No => {
                let owner = self.owner_for(&event, &tag);
                self.streams.observe(&event, &owner, &tag);
                self.judge(&event, &tag, owner.as_ref())
            }
        };
        if !keep {
            return Vec::new();
        }
        match &mut event {
            // Authoritative: the snapshot restates the conversation, so what
            // it carries is re-read — and what it does not carry is left as
            // the run established it, as the verifiers leave it.
            Event::MessagesSnapshot(snapshot) => {
                self.seed_hidden(&snapshot.messages, true);
                let hidden_calls = &self.hidden_tool_calls;
                snapshot
                    .messages
                    .retain_mut(|message| Self::show_message(message, hidden_calls));
            }
            // History, not a rewrite: what it carries is remembered alongside
            // what the run has already shown.
            Event::RunStarted(started) => {
                if let Some(input) = &mut started.input {
                    self.seed_hidden(&input.messages, false);
                    let hidden_calls = &self.hidden_tool_calls;
                    input
                        .messages
                        .retain_mut(|message| Self::show_message(message, hidden_calls));
                }
            }
            Event::StateSnapshot(_)
            | Event::StateDelta(_)
            | Event::ToolCallResult(_)
            | Event::ActivitySnapshot(_)
            | Event::ActivityDelta(_) => {
                event.clear_subagent_run_id();
            }
            Event::RunFinished(finished) => Self::strip_interrupt_tags(finished),
            _ => {}
        }
        vec![event]
    }

    /// Whether the consumer sees an event with an id, by who owns it.
    fn judge(
        &mut self,
        event: &Event,
        tag: &Option<SubagentRunId>,
        owner: Option<&SubagentRunId>,
    ) -> bool {
        let owned = tag.is_some();
        match event {
            Event::SubagentStarted(_) | Event::SubagentFinished(_) | Event::SubagentError(_) => {
                false
            }

            Event::TextMessageStart(e) => self.opened(Family::Text, &e.message_id, owner),
            Event::TextMessageChunk(e) => match &e.message_id {
                Some(id) => self.opened(Family::Text, id, owner),
                None => unreachable!("a bare chunk was resolved or passed through"),
            },
            Event::TextMessageContent(e) => self.continued(Family::Text, &e.message_id, owned),
            Event::TextMessageEnd(e) => self.closed(Family::Text, &e.message_id, owned),

            Event::ReasoningStart(e) => self.opened(Family::Reasoning, &e.message_id, owner),
            Event::ReasoningMessageStart(e) => self.opened(Family::Reasoning, &e.message_id, owner),
            Event::ReasoningMessageChunk(e) => match &e.message_id {
                Some(id) => self.opened(Family::Reasoning, id, owner),
                None => unreachable!("a bare chunk was resolved or passed through"),
            },
            Event::ReasoningMessageContent(e) => {
                self.continued(Family::Reasoning, &e.message_id, owned)
            }
            Event::ReasoningMessageEnd(e) => self.closed(Family::Reasoning, &e.message_id, owned),
            Event::ReasoningEnd(e) => self.closed(Family::Reasoning, &e.message_id, owned),

            Event::ToolCallStart(e) => self.call_opened(&e.tool_call_id, owner),
            Event::ToolCallChunk(e) => match &e.tool_call_id {
                Some(id) => self.call_opened(id, owner),
                None => unreachable!("a bare chunk was resolved or passed through"),
            },
            Event::ToolCallArgs(e) => self.call_continued(&e.tool_call_id, owned),
            Event::ToolCallEnd(e) => {
                let keep = self.call_continued(&e.tool_call_id, owned);
                self.open_visibility
                    .remove(&(Family::Tool, e.tool_call_id.as_str().to_owned()));
                keep
            }
            // A result goes where its call went, whoever executed it: one for
            // a call the consumer never saw is a protocol error, and one for
            // a call it did see is owed.
            Event::ToolCallResult(e) => self
                .call_visibility
                .get(&e.tool_call_id)
                .copied()
                .unwrap_or_else(|| !self.hidden_tool_calls.contains_key(&e.tool_call_id)),

            // An activity is owned by the snapshot that minted it, and only a
            // replacing snapshot re-mints it — the verifiers' rule. A merge
            // into a visible activity is kept whoever wrote it, as a result
            // for a visible call is: the entity is the consumer's to keep
            // whole.
            Event::ActivitySnapshot(e) => {
                let existing = self.activities.get(&e.message_id).copied();
                let hidden = match existing {
                    Some(hidden) if !e.replace => hidden,
                    _ => owned,
                };
                self.activities.insert(e.message_id.clone(), hidden);
                !hidden
            }
            Event::ActivityDelta(e) => {
                !self.activities.get(&e.message_id).copied().unwrap_or(false)
            }

            // An opaque blob for an entity the consumer never saw goes with
            // the entity, as `FilterToolCalls` drops one for a dropped call.
            Event::ReasoningEncryptedValue(e) => {
                !owned
                    && match e.subtype {
                        crate::ReasoningEncryptedValueSubtype::ToolCall => !self
                            .hidden_tool_calls
                            .contains_key(&ToolCallId::new(e.entity_id.clone())),
                        crate::ReasoningEncryptedValueSubtype::Message => {
                            let id = MessageId::new(e.entity_id.clone());
                            !self.hidden_text.contains_key(&id)
                                && !self.hidden_reasoning.contains_key(&id)
                        }
                    }
            }

            // The thread's state, whoever published it.
            Event::StateSnapshot(_) | Event::StateDelta(_) => true,

            Event::RunFinished(_) | Event::RunError(_) => {
                self.open_visibility.clear();
                true
            }

            _ => !owned,
        }
    }

    fn owners_mut(&mut self, family: Family) -> &mut HashMap<MessageId, SubagentRunId> {
        match family {
            Family::Text => &mut self.hidden_text,
            Family::Reasoning => &mut self.hidden_reasoning,
            Family::Tool => unreachable!("tool calls have their own map"),
        }
    }

    fn is_hidden(&self, family: Family, id: &str) -> bool {
        match family {
            Family::Text => self.hidden_text.contains_key(&MessageId::new(id)),
            Family::Reasoning => self.hidden_reasoning.contains_key(&MessageId::new(id)),
            Family::Tool => self.hidden_tool_calls.contains_key(&ToolCallId::new(id)),
        }
    }

    /// A message opens under `owner` — the first writer keeps it — and the
    /// consumer sees it iff the owner is the parent, unless it is already
    /// open, in which case it keeps the visibility it was opened with.
    fn opened(&mut self, family: Family, id: &MessageId, owner: Option<&SubagentRunId>) -> bool {
        if let Some(owner) = owner {
            self.owners_mut(family)
                .entry(id.clone())
                .or_insert_with(|| owner.clone());
        }
        *self
            .open_visibility
            .entry((family, id.as_str().to_owned()))
            .or_insert(owner.is_none())
    }

    fn continued(&self, family: Family, id: &MessageId, owned: bool) -> bool {
        !owned
            && self
                .open_visibility
                .get(&(family, id.as_str().to_owned()))
                .copied()
                .unwrap_or_else(|| !self.is_hidden(family, id.as_str()))
    }

    fn closed(&mut self, family: Family, id: &MessageId, owned: bool) -> bool {
        let keep = self.continued(family, id, owned);
        self.open_visibility
            .remove(&(family, id.as_str().to_owned()));
        keep
    }

    fn call_opened(&mut self, id: &ToolCallId, owner: Option<&SubagentRunId>) -> bool {
        if let Some(owner) = owner {
            self.hidden_tool_calls
                .entry(id.clone())
                .or_insert_with(|| owner.clone());
        }
        let visible = *self
            .open_visibility
            .entry((Family::Tool, id.as_str().to_owned()))
            .or_insert(owner.is_none());
        self.call_visibility.insert(id.clone(), visible);
        visible
    }

    fn call_continued(&self, id: &ToolCallId, owned: bool) -> bool {
        !owned
            && self
                .open_visibility
                .get(&(Family::Tool, id.as_str().to_owned()))
                .copied()
                .unwrap_or_else(|| !self.hidden_tool_calls.contains_key(id))
    }

    /// Re-reads what a replay says about ownership. Authoritatively — a
    /// `MESSAGES_SNAPSHOT` — an untagged message takes its id back for the
    /// parent; as history — the `RUN_STARTED` echo — only the subagents'
    /// messages are added. A tool message goes where its call went, so one
    /// answering a visible call is not hidden however it is tagged.
    fn seed_hidden(&mut self, messages: &[crate::Message], authoritative: bool) {
        for message in messages {
            let id = message.id().clone();
            if let crate::Message::Activity(_) = message {
                if authoritative || !self.activities.contains_key(&id) {
                    self.activities
                        .insert(id, message.subagent_run_id().is_some());
                }
                continue;
            }
            let owner = match message {
                crate::Message::Tool(tool) => {
                    self.hidden_tool_calls.get(&tool.tool_call_id).cloned()
                }
                _ => message.subagent_run_id().cloned(),
            };
            let calls: Vec<ToolCallId> = match message {
                crate::Message::Assistant(assistant) => assistant
                    .tool_calls
                    .iter()
                    .flatten()
                    .map(|call| call.id.clone())
                    .collect(),
                _ => Vec::new(),
            };
            let family = match message {
                crate::Message::Reasoning(_) => Family::Reasoning,
                _ => Family::Text,
            };
            match owner {
                Some(owner) => {
                    for call in calls {
                        self.hidden_tool_calls.insert(call, owner.clone());
                    }
                    self.owners_mut(family).insert(id, owner);
                }
                None if authoritative => {
                    self.owners_mut(family).remove(&id);
                    for call in &calls {
                        self.hidden_tool_calls.remove(call);
                    }
                }
                None => {}
            }
        }
    }

    /// Whether a replayed message reaches the consumer, stripping the tag
    /// from the one kind that may carry one there: a tool message answering
    /// a call the consumer saw is the parent's, whoever executed it.
    fn show_message(
        message: &mut crate::Message,
        hidden_calls: &HashMap<ToolCallId, SubagentRunId>,
    ) -> bool {
        match message {
            crate::Message::Tool(tool) => {
                if hidden_calls.contains_key(&tool.tool_call_id) {
                    return false;
                }
                tool.subagent_run_id = None;
                true
            }
            _ => message.subagent_run_id().is_none(),
        }
    }
}

impl StreamTransformer for SubagentFilter {
    fn transform(&mut self, event: Event) -> Vec<Event> {
        match self.mode {
            SubagentVisibility::Attributed => vec![event],
            SubagentVisibility::Inline => self.inline(event),
            SubagentVisibility::Hidden => self.hidden(event),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ReasoningEncryptedValueSubtype, TextMessageRole};
    use serde_json::json;

    #[test]
    fn allow_list_drops_everything_unlisted() {
        let mut filter = FilterToolCalls::allow(["search"]);
        assert_eq!(
            filter
                .transform(Event::tool_call_start("c1", "search"))
                .len(),
            1
        );
        assert!(
            filter
                .transform(Event::tool_call_start("c2", "delete_everything"))
                .is_empty()
        );
        assert!(
            filter
                .transform(Event::tool_call_args("c2", "{}"))
                .is_empty()
        );
        assert!(
            filter
                .transform(Event::tool_call_result("m1", "c2", "gone"))
                .is_empty()
        );
        assert_eq!(filter.transform(Event::tool_call_args("c1", "{}")).len(), 1);
    }

    #[test]
    fn filter_leaves_unrelated_events_alone() {
        let mut filter = FilterToolCalls::deny(["nope"]);
        let event = Event::text_message_start("m1", TextMessageRole::Assistant);
        assert_eq!(filter.transform(event.clone()), vec![event]);
    }

    #[test]
    fn filter_drops_encrypted_reasoning_for_a_dropped_call() {
        let mut filter = FilterToolCalls::deny(["nope"]);
        filter.transform(Event::tool_call_start("c1", "nope"));
        let blob = Event::reasoning_encrypted_value(
            ReasoningEncryptedValueSubtype::ToolCall,
            "c1",
            "opaque",
        );
        assert!(filter.transform(blob).is_empty());
    }

    #[test]
    fn promoting_keeps_the_result_by_default() {
        let mut promote = ToolResultToState::snapshot("load");
        promote.transform(Event::tool_call_start("c1", "load"));
        let result = Event::tool_call_result("m1", "c1", r#"{"a":1}"#);
        assert_eq!(
            promote.transform(result.clone()),
            vec![result, Event::state_snapshot(json!({"a": 1}))]
        );
    }

    #[test]
    fn promoting_a_patch_emits_a_delta() {
        let mut promote = ToolResultToState::delta("patch_state").replacing();
        promote.transform(Event::tool_call_start("c1", "patch_state"));
        let content = r#"[{"op":"replace","path":"/step","value":2}]"#;
        assert_eq!(
            promote.transform(Event::tool_call_result("m1", "c1", content)),
            vec![Event::state_delta(vec![PatchOperation::replace(
                "/step", 2
            )])]
        );
    }

    #[test]
    fn unparseable_content_passes_through_untouched() {
        let mut promote = ToolResultToState::snapshot("load").replacing();
        promote.transform(Event::tool_call_start("c1", "load"));
        let result = Event::tool_call_result("m1", "c1", "not json");
        assert_eq!(promote.transform(result.clone()), vec![result]);
    }

    #[test]
    fn other_tools_are_not_promoted() {
        let mut promote = ToolResultToState::snapshot("load");
        promote.transform(Event::tool_call_start("c1", "something_else"));
        let result = Event::tool_call_result("m1", "c1", r#"{"a":1}"#);
        assert_eq!(promote.transform(result.clone()), vec![result]);
    }

    #[test]
    fn chain_runs_transformers_in_order() {
        let mut chain = TransformerChain::new()
            .with(FilterToolCalls::deny(["load"]))
            .with(ToolResultToState::snapshot("load"));
        // The filter removes the call first, so the promoter never sees it.
        assert!(
            chain
                .transform(Event::tool_call_start("c1", "load"))
                .is_empty()
        );
        assert!(
            chain
                .transform(Event::tool_call_result("m1", "c1", r#"{"a":1}"#))
                .is_empty()
        );
    }
}
